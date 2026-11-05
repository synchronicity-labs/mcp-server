import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import {
  chosenOrganization,
  currentOrganizationSession,
  ORGANIZATION_HEADER,
  OrganizationSession,
  type OrganizationSummary,
  runInOrganization,
} from '../organization-selection.js';
import type { McpToolDefinition, ToolRequestContext } from './generator.js';

/** GET route listing the caller's organizations (sync-api-v2, CRAFT-7789). */
export const ORGANIZATIONS_PATH = '/v2/account/organizations';

/** API keys act for one organization; OAuth and device-auth sessions can choose per request. */
export type CredentialKind = 'api_key' | 'user';

const SWITCH_HINT =
  'Call organizations_list to see the organizations this account belongs to, then organizations_select with an id to switch this session, or pass organizationId on a single paid create (and its estimate) to run only that call there.';
const API_KEY_HINT =
  'This connection uses an API key, and API keys are bound to the organization that created them. To work in another organization, use an API key created in it, or sign in to Sync instead of using SYNC_API_KEY.';
const REFUSED_STEP =
  'The session keeps its current organization. Pick an id returned by organizations_list and explain the message to the user; do not retry the same id.';

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

/** Flags as a list, or as an object of booleans; either becomes the sorted enabled names. */
function enabledFeatures(value: unknown): string[] | undefined {
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === 'string').sort();
  if (value && typeof value === 'object')
    return Object.entries(value)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name)
      .sort();
  return undefined;
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

function sessionOf(): OrganizationSession {
  return currentOrganizationSession() ?? new OrganizationSession();
}

function summary(organization: { id: string; name: string | null }): OrganizationSummary {
  return { id: organization.id, name: organization.name };
}

function describe(organization: OrganizationSummary | undefined): string {
  if (!organization) return 'an unknown organization';
  return organization.name ? `${organization.name} (${organization.id})` : organization.id;
}

/** The credential's own organization, read once a minute at most. */
async function defaultOrganization(
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

function apiKeyBound(organization: OrganizationSummary | undefined): Error {
  return new Error(
    `API keys are bound to one organization, and this key belongs to ${describe(organization)}. ${API_KEY_HINT}`,
  );
}

/** Reads the account as `organizationId`; refuses unless the API answered for that organization. */
async function readAccountAs(
  http: HttpClient,
  organizationId: string,
  signal: AbortSignal | undefined,
): Promise<AccountOverview & { organization: z.infer<typeof accountOrganizationSchema> }> {
  let account: AccountOverview;
  try {
    account = await readAccount(http, signal, organizationId);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status !== 401) error.nextStep = REFUSED_STEP;
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
  plan: z.union([z.string(), planSchema]).nullable().optional(),
  isCurrent: z.boolean(),
});

function listedOrganizations(value: unknown): z.infer<typeof organizationListItem>[] {
  const items = Array.isArray(value)
    ? value
    : z.object({ organizations: z.array(z.unknown()) }).parse(value).organizations;
  return z
    .array(organizationListItem.extend({ isCurrent: z.boolean().optional().default(false) }))
    .parse(items);
}

const organizationSummarySchema = z.object({ id: z.uuid(), name: z.string().nullable() });

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
        'List the Sync organizations this account belongs to, with role and plan, marking the one this session runs in (isCurrent). Use it when the user names an organization or team, or asks where work is created, then switch with organizations_select or pass organizationId on one paid create. With an API key, lists only the key’s organization.',
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
        if (credential === 'api_key') {
          const account = await readAccount(http, context?.signal);
          if (!account.organization)
            throw new Error('Sync did not report the active organization.');
          session.rememberDefault(summary(account.organization));
          return {
            organizations: [
              {
                id: account.organization.id,
                name: account.organization.name,
                role: account.organization.role ?? 'api_key',
                plan: account.plan ?? null,
                isCurrent: true,
              },
            ],
            current: summary(account.organization),
            selectedBy: 'credential',
            howToSwitch: API_KEY_HINT,
          };
        }
        const selected = session.selected;
        const organizations = listedOrganizations(
          await http.request('get', ORGANIZATIONS_PATH, { signal: context?.signal }),
        ).map((organization) => ({
          ...organization,
          isCurrent: selected ? organization.id === selected.id : organization.isCurrent,
        }));
        const current = organizations.find((organization) => organization.isCurrent);
        if (current && !selected) session.rememberDefault(summary(current));
        return {
          organizations,
          current: current ? summary(current) : null,
          selectedBy: selected ? 'session' : 'credential',
          howToSwitch: SWITCH_HINT,
        };
      },
    },
    {
      name: 'organizations_select',
      title: 'Switch the Sync organization',
      description:
        'Switch this session to another Sync organization the user belongs to; every later call runs there, including paid generations, until the session ends or another switch. Use an id from organizations_list, and only when the user asks to work in that organization. Returns the new organization’s plan, generation limits and feature flags. The API checks membership; API keys are bound to one organization and cannot switch. To run a single generation elsewhere, pass organizationId on that create instead.',
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

/** Paid creates, and the estimates that quote them, that take a one-call organizationId. */
const PER_CALL_ORGANIZATION_TOOLS = new Set([
  'create-lipsync',
  'create-lipsync-from-assets',
  'create-timeline-lipsync',
  'create-translate-and-dub',
  'create-translation-preview',
  'estimate-translation-preview',
  'create-dialogue-preview',
  'create-dialogue-video',
  'estimate-dialogue-video',
  'generate_create-generation',
  'generate_estimate-cost',
  // From the batch tools (CRAFT-7781); applies once they are registered.
  'batches_create',
]);

const organizationOutput = organizationSummarySchema
  .optional()
  .describe('The Sync organization this call ran in.');

const organizationIdInput = z
  .uuid()
  .optional()
  .describe(
    'Run only this call in another of the user’s Sync organizations, by id from organizations_list, when the user asks for it (for example “generate this in the Acme org”). The session keeps its organization; reads of the ids this call returns stay in this organization. Omit to use the session’s organization.',
  );

// Ids a create returns: its job, generation, project or output asset.
function returnedIds(result: unknown): string[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  return Object.entries(result).flatMap(([key, value]) =>
    (key === 'id' || key.endsWith('Id')) && z.uuid().safeParse(value).success
      ? [value as string]
      : [],
  );
}

async function organizationForCall(
  http: HttpClient,
  credential: CredentialKind,
  session: OrganizationSession,
  organizationId: string,
  signal: AbortSignal | undefined,
): Promise<{ organization: OrganizationSummary; scoped: boolean }> {
  const active = chosenOrganization();
  if (active?.id === organizationId) return { organization: active, scoped: true };
  // Running in the credential's own organization needs no header.
  if (credential === 'api_key' || !active) {
    const own =
      credential === 'api_key'
        ? await defaultOrganization(http, session, signal)
        : await defaultOrganization(http, session, signal).catch(() => undefined);
    if (own?.id === organizationId) return { organization: own, scoped: false };
    if (credential === 'api_key') throw apiKeyBound(own);
  }
  const account = await readAccountAs(http, organizationId, signal);
  return { organization: summary(account.organization), scoped: true };
}

function withOrganization(result: unknown, organization: OrganizationSummary | undefined): unknown {
  if (!organization || !result || typeof result !== 'object' || Array.isArray(result))
    return result;
  return { ...result, organization };
}

/**
 * Adds an optional organizationId that runs one paid create in another organization,
 * and reports the organization each call ran in.
 */
export function withOrganizationChoice(
  tool: McpToolDefinition,
  http: HttpClient,
  credential: CredentialKind,
): McpToolDefinition {
  if (!PER_CALL_ORGANIZATION_TOOLS.has(tool.name)) return tool;
  const run = async <T>(
    args: Record<string, unknown>,
    context: ToolRequestContext | undefined,
    handler: (fields: Record<string, unknown>) => Promise<T>,
  ): Promise<{ result: T; organization?: OrganizationSummary }> => {
    const { organizationId, ...fields } = args;
    const session = sessionOf();
    // Ids a create returns are read in the organization it ran in, even after a switch.
    // API keys have one organization and never send the header, so they remember nothing.
    const remember = (ids: string[], organization: OrganizationSummary | undefined) => {
      if (credential === 'user' && organization) session.rememberIds(ids, organization);
    };
    const execute = async (organization: Promise<OrganizationSummary | undefined>) => {
      try {
        return await handler(fields);
      } catch (error) {
        // An uncertain admission names its generation; recovery must read the same organization.
        if (error instanceof ApiRequestError && error.generationId)
          remember([error.generationId], await organization);
        throw error;
      }
    };
    const finish = async (result: T, organization: OrganizationSummary | undefined) => {
      remember(
        returnedIds(
          tool.resultFormat === 'mcp' ? (result as CallToolResult).structuredContent : result,
        ),
        organization,
      );
      return { result, organization };
    };
    if (typeof organizationId !== 'string') {
      const active = chosenOrganization();
      // Read alongside the call, so reporting the organization adds no latency.
      const lookup = active
        ? Promise.resolve(active)
        : defaultOrganization(http, session, context?.signal).catch(() => undefined);
      const result = await execute(lookup);
      return finish(result, await lookup);
    }
    const { organization, scoped } = await organizationForCall(
      http,
      credential,
      session,
      organizationId,
      context?.signal,
    );
    const known = Promise.resolve(organization);
    const result = scoped
      ? await runInOrganization(organization, () => execute(known))
      : await runInOrganization(undefined, () => execute(known));
    return finish(result, organization);
  };
  const definition = {
    ...tool,
    inputSchema: { ...tool.inputSchema, organizationId: organizationIdInput },
    ...(tool.outputSchema
      ? { outputSchema: { ...tool.outputSchema, organization: organizationOutput } }
      : {}),
  };
  if (tool.resultFormat === 'mcp')
    return {
      ...definition,
      resultFormat: 'mcp',
      handler: async (args, context) => {
        const { result, organization } = await run(args, context, (fields) =>
          tool.handler(fields, context),
        );
        if (result.isError || !organization) return result;
        return {
          ...result,
          structuredContent: withOrganization(result.structuredContent, organization) as
            | Record<string, unknown>
            | undefined,
        };
      },
    };
  return {
    ...definition,
    resultFormat: 'json',
    handler: async (args, context) => {
      const { result, organization } = await run(args, context, (fields) =>
        tool.handler(fields, context),
      );
      return withOrganization(result, organization);
    },
  };
}
