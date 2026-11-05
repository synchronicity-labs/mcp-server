import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import {
  currentOrganizationSession,
  ORGANIZATION_HEADER,
  OrganizationSession,
  type OrganizationSummary,
} from '../organization-selection.js';
import type { McpToolDefinition } from './generator.js';

/** GET route listing the caller's organizations (sync-api-v2, CRAFT-7789). */
export const ORGANIZATIONS_PATH = '/v2/account/organizations';

/** API keys act for one organization; OAuth and device-auth sessions can choose per request. */
export type CredentialKind = 'api_key' | 'user';

const SWITCH_HINT =
  'Call organizations_list to see the organizations this connection can act in, then organizations_select with an id to switch this session, or pass organizationId on a single paid create (and its estimate) to run only that call there. A Sync app connection (OAuth) acts only in the organizations ticked when it was connected; to add one, the user reconnects Sync and ticks it.';
const API_KEY_HINT =
  'This connection uses an API key, and API keys are bound to the organization that created them. To work in another organization, use an API key created in it, or sign in to Sync instead of using SYNC_API_KEY.';
const REFUSED_STEP =
  'The session keeps its current organization. Pick an id returned by organizations_list and explain the message to the user; do not retry the same id.';

// Refusals of x-sync-organization-id (sync-api-v2 #7863). The request never fell back to
// another organization, so nothing ran.
const ORGANIZATION_REFUSALS: Record<string, string> = {
  organization_access_denied:
    'Use an organization id from organizations_list, or omit organizationId to use the current one.',
  oauth_organization_not_granted:
    'To add it, reconnect the app and tick that organization on the consent screen, keeping the others you still want. Until then, use an organization from organizations_list.',
  api_key_organization_bound:
    "Omit organizationId, or use an API key created in the other organization's Studio settings.",
  invalid_organization_id: 'Send one organization id from organizations_list.',
};

/**
 * Next step for a refused organization: the API's own suggestion (for a connection without
 * a grant, reconnecting and ticking that organization), then what not to do.
 */
export function organizationNextStep(error: ApiRequestError): string | undefined {
  const fallback = error.code ? ORGANIZATION_REFUSALS[error.code] : undefined;
  if (!fallback) return undefined;
  const suggestion = error.suggestion
    ? `${error.suggestion} Here, organizations_list lists the organizations this connection can use.`
    : fallback;
  return `${suggestion} Tell the user; retrying the same organization fails the same way.`;
}

export function switchHint(credential: CredentialKind): string {
  return credential === 'api_key' ? API_KEY_HINT : SWITCH_HINT;
}

const planSchema = z.object({ id: z.string(), name: z.string() });
const generationLimitsSchema = z.object({
  concurrency: z.number().finite().nonnegative(),
  maxOutputDurationSeconds: z.number().finite().nonnegative(),
});
const accountOrganizationSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  role: z.string().optional(),
});

export const featuresSchema = z
  .array(z.string())
  .describe(
    'Feature flags enabled for this organization. Tools that depend on a flag follow the active organization.',
  );

export type AccountOverview = {
  organization?: z.infer<typeof accountOrganizationSchema>;
  credentialType?: string;
  plan?: z.infer<typeof planSchema>;
  limits?: z.infer<typeof generationLimitsSchema>;
  features?: string[];
};

/** GET /v2/account `features`: the flag names enabled for this credential, sorted. */
function enabledFeatures(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string').sort();
}

/** GET /v2/account, read field by field so one unexpected field never hides the rest. */
export function parseAccountOverview(value: unknown): AccountOverview {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const organization = accountOrganizationSchema.safeParse(record.organization).data;
  const plan = planSchema.safeParse(record.plan).data;
  const limits = generationLimitsSchema.safeParse(record.limits).data;
  const features = enabledFeatures(record.features);
  return {
    ...(organization ? { organization } : {}),
    ...(typeof record.credentialType === 'string' ? { credentialType: record.credentialType } : {}),
    ...(plan ? { plan } : {}),
    ...(limits ? { limits } : {}),
    ...(features ? { features } : {}),
  };
}

async function readAccount(
  http: HttpClient,
  signal: AbortSignal | undefined,
  organizationId?: string,
): Promise<AccountOverview> {
  return parseAccountOverview(
    await http.request('get', '/v2/account', {
      signal,
      ...(organizationId ? { headers: { [ORGANIZATION_HEADER]: organizationId } } : {}),
    }),
  );
}

export function sessionOf(): OrganizationSession {
  return currentOrganizationSession() ?? new OrganizationSession();
}

export function summary(organization: { id: string; name: string | null }): OrganizationSummary {
  return { id: organization.id, name: organization.name };
}

function describe(organization: OrganizationSummary | undefined): string {
  if (!organization) return 'an unknown organization';
  return organization.name ? `${organization.name} (${organization.id})` : organization.id;
}

/** The credential's own organization, read once a minute at most. */
export async function defaultOrganization(
  http: HttpClient,
  session: OrganizationSession,
  signal: AbortSignal | undefined,
): Promise<OrganizationSummary> {
  const cached = session.defaultOrganization();
  if (cached) return cached;
  const account = await readAccount(http, signal);
  if (!account.organization) throw new Error('Sync did not report the active organization.');
  const organization = summary(account.organization);
  session.rememberDefault(organization);
  return organization;
}

export function apiKeyBound(organization: OrganizationSummary | undefined): Error {
  return new Error(
    `API keys are bound to one organization, and this key belongs to ${describe(organization)}. ${API_KEY_HINT}`,
  );
}

/** Reads the account as `organizationId`; refuses unless the API answered for that organization. */
export async function readAccountAs(
  http: HttpClient,
  organizationId: string,
  signal: AbortSignal | undefined,
): Promise<AccountOverview & { organization: z.infer<typeof accountOrganizationSchema> }> {
  let account: AccountOverview;
  try {
    account = await readAccount(http, signal, organizationId);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status !== 401)
      error.nextStep = organizationNextStep(error) ?? REFUSED_STEP;
    throw error;
  }
  if (account.organization?.id !== organizationId)
    throw new Error(
      `Sync did not switch to organization ${organizationId}: the API answered for ${describe(account.organization)}, so this connection cannot choose an organization per request yet. Nothing was changed.`,
    );
  return { ...account, organization: account.organization };
}

const organizationListItem = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  role: z.string(),
  plan: planSchema.optional(),
  isCurrent: z.boolean(),
});

// GET /v2/account/organizations: what the credential can act in, current one first.
const organizationsResponse = z.object({ organizations: z.array(organizationListItem) });

export const organizationSummarySchema = z.object({ id: z.uuid(), name: z.string().nullable() });

const listOutput = {
  organizations: z.array(organizationListItem),
  current: organizationSummarySchema
    .nullable()
    .describe('The organization tools in this session run in.'),
  selectedBy: z
    .enum(['session', 'credential'])
    .describe(
      'session: chosen with organizations_select. credential: the default of this sign-in or API key.',
    ),
  howToSwitch: z.string(),
};

const selectOutput = {
  organization: accountOrganizationSchema,
  previousOrganization: organizationSummarySchema.nullable(),
  changed: z.boolean(),
  plan: planSchema.optional(),
  generationLimits: generationLimitsSchema
    .optional()
    .describe('Generations that can run at once and the longest output, in seconds.'),
  features: featuresSchema.optional(),
  howToSwitch: z.string(),
};

function sameFeatures(left: string[] | undefined, right: string[] | undefined): boolean {
  if ((left === undefined) !== (right === undefined)) return false;
  return (left ?? []).join('\n') === (right ?? []).join('\n');
}

function selection(
  account: AccountOverview & { organization: z.infer<typeof accountOrganizationSchema> },
  previous: OrganizationSummary | undefined,
  howToSwitch: string,
) {
  return {
    organization: account.organization,
    previousOrganization: previous ?? null,
    changed: previous?.id !== account.organization.id,
    ...(account.plan ? { plan: account.plan } : {}),
    ...(account.limits ? { generationLimits: account.limits } : {}),
    ...(account.features ? { features: account.features } : {}),
    howToSwitch,
  };
}

/** API keys cannot switch; selecting the key's own organization only reports it. */
async function selectWithApiKey(
  http: HttpClient,
  session: OrganizationSession,
  organizationId: string,
  signal: AbortSignal | undefined,
) {
  const account = await readAccount(http, signal);
  if (!account.organization || account.organization.id !== organizationId)
    throw apiKeyBound(account.organization && summary(account.organization));
  session.features = account.features;
  return selection(
    { ...account, organization: account.organization },
    summary(account.organization),
    API_KEY_HINT,
  );
}

export function createOrganizationTools(
  http: HttpClient,
  credential: CredentialKind,
): McpToolDefinition[] {
  return [
    {
      name: 'organizations_list',
      title: 'List your Sync organizations',
      description:
        'List the Sync organizations this connection can act in, with role and plan, marking the one this session runs in (isCurrent). Use it when the user names an organization or team, or asks where work is created, then switch with organizations_select or pass organizationId on one paid create. A Sync app connection lists the organizations ticked when it was connected; to add another, the user reconnects Sync and ticks it. With an API key, lists only the key’s organization.',
      inputSchema: {},
      outputSchema: listOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (_args, context) => {
        const session = sessionOf();
        // An API key lists only its own organization; it never sends the header.
        const selected = session.selected;
        const organizations = organizationsResponse
          .parse(await http.request('get', ORGANIZATIONS_PATH, { signal: context?.signal }))
          .organizations.map((organization) => ({
            ...organization,
            isCurrent: selected ? organization.id === selected.id : organization.isCurrent,
          }));
        const current = organizations.find((organization) => organization.isCurrent);
        if (current && !selected) session.rememberDefault(summary(current));
        return {
          organizations,
          current: current ? summary(current) : null,
          selectedBy: selected ? 'session' : 'credential',
          howToSwitch: switchHint(credential),
        };
      },
    },
    {
      name: 'organizations_select',
      title: 'Switch the Sync organization',
      description:
        'Switch this session to another Sync organization the user belongs to; every later call runs there, including paid generations, until the session ends or another switch. Use an id from organizations_list, and only when the user asks to work in that organization. Returns the new organization’s plan, generation limits and feature flags. The API checks access: a Sync app connection can switch only to organizations ticked when it was connected, and otherwise says to reconnect and tick it; API keys are bound to one organization and cannot switch. To run a single generation elsewhere, pass organizationId on that create instead.',
      inputSchema: {
        organizationId: z.uuid().describe('Organization id returned by organizations_list.'),
      },
      outputSchema: selectOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (args, context) => {
        const organizationId = z.uuid().parse(args.organizationId);
        const session = sessionOf();
        if (credential === 'api_key')
          return selectWithApiKey(http, session, organizationId, context?.signal);
        const previous = session.selected ?? session.defaultOrganization();
        const account = await readAccountAs(http, organizationId, context?.signal);
        const previousFeatures = session.features;
        session.selected = summary(account.organization);
        session.features = account.features;
        // Tools that depend on a feature flag follow the organization; let the client re-list.
        if (previous?.id !== organizationId || !sameFeatures(previousFeatures, account.features))
          context?.toolListChanged?.();
        return selection(account, previous, SWITCH_HINT);
      },
    },
  ];
}
