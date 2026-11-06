import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import { currentOrganizationSession, type FeatureStamp } from '../organization-selection.js';
import type { McpToolDefinition } from './generator.js';
import {
  type AccountOverview,
  type CredentialKind,
  featuresSchema,
  parseAccountOverview,
  switchHint,
} from './organizations.js';

const accountContext = z.object({
  account: z
    .object({
      id: z.uuid(),
      email: z.string().nullable(),
      name: z.string().nullable(),
    })
    .nullable(),
  limits: z
    .object({
      seats: z.number().finite().nonnegative(),
      voiceClone: z.number().finite().nonnegative(),
    })
    .optional(),
  organization: z.object({
    id: z.uuid(),
    name: z.string().nullable(),
    role: z.string(),
  }),
  plan: z.object({ id: z.string(), name: z.string() }).optional(),
  generationLimits: z
    .object({
      concurrency: z.number().finite().nonnegative(),
      maxOutputDurationSeconds: z.number().finite().nonnegative(),
    })
    .optional()
    .describe(
      'Generations that can run at once and the longest output one may produce, in seconds. Plan a job within these before creating it.',
    ),
  capabilities: z.object({
    projectRenaming: z.literal(true),
    chatgptAnalytics: z.literal(true).optional(),
    studioDraftSync: z.literal(true).optional(),
    studioViewSync: z.literal(true).optional(),
    audioTrimming: z.literal(true).optional(),
  }),
  features: featuresSchema.optional(),
  organizationChoice: z
    .object({
      selectedBy: z
        .enum(['session', 'credential'])
        .describe(
          'session: chosen with organizations_select. credential: the default of this sign-in or API key.',
        ),
      howToSwitch: z.string(),
    })
    .describe('How the active organization was chosen, and how to work in another one.'),
});

type Caller = Pick<z.infer<typeof accountContext>, 'account' | 'organization'>;

/**
 * GET /v2/account reflects the organization chosen for this request, so it wins over the
 * caller identity. Remembers what was read for this MCP session, unless the session switched
 * organization while it was read (`stamp`, taken before the read).
 */
function activeOrganization(
  caller: Caller,
  overview: AccountOverview | undefined,
  stamp: FeatureStamp | undefined,
): Caller['organization'] {
  const organization = overview?.organization
    ? {
        id: overview.organization.id,
        name: overview.organization.name,
        role: overview.organization.role ?? caller.organization.role,
      }
    : caller.organization;
  const session = currentOrganizationSession();
  if (session && !session.selected)
    session.rememberDefault({ id: organization.id, name: organization.name });
  if (session && overview && stamp)
    session.recordFeatures(overview.features, stamp, overview.organization?.id);
  return organization;
}

export function createAccountContextTool(
  http: HttpClient,
  studioDraftSync = false,
  studioViewSync = false,
  audioTrimming = false,
  chatgptAnalytics = false,
  credential: CredentialKind = 'user',
): McpToolDefinition {
  return {
    name: 'account_get-context',
    title: 'Read connected Sync account',
    description:
      'Read the authenticated account and the organization this session runs in (all generations are created there), for account display and personal asset scope, its plan, generation limits (concurrency and longest output), feature flags, team seats and voice-clone limits. organizationChoice says how that organization was chosen and how to switch. API keys have no signed-in account. For credits, balance or billed usage use account_get-usage; to switch organization use organizations_select when available. This does not grant permissions or change the organization.',
    inputSchema: {},
    outputSchema: accountContext.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (_args, context) => {
      const identity = await http.request('get', '/v2/oauth/account', {
        signal: context?.signal,
      });
      // A limits outage must not erase verified identity; expired credentials still need linking.
      const optional = async (path: string): Promise<unknown> => {
        try {
          return await http.request('get', path, { signal: context?.signal });
        } catch (error) {
          context?.signal?.throwIfAborted();
          if (error instanceof ApiRequestError && error.status === 401) throw error;
          return undefined;
        }
      };
      const limits = await optional('/v2/plans/limits');
      const stamp = currentOrganizationSession()?.featureStamp();
      const overview = await optional('/v2/account');
      const plan = overview === undefined ? undefined : parseAccountOverview(overview);
      const caller = z
        .object({
          account: accountContext.shape.account,
          organization: accountContext.shape.organization,
        })
        .parse(identity);
      return accountContext.parse({
        account: caller.account,
        organization: activeOrganization(caller, plan, stamp),
        ...(limits === undefined ? {} : { limits }),
        ...(plan?.plan ? { plan: plan.plan } : {}),
        ...(plan?.limits ? { generationLimits: plan.limits } : {}),
        capabilities: {
          projectRenaming: true,
          ...(chatgptAnalytics && context?.clientProfile?.name === 'chatgpt'
            ? { chatgptAnalytics: true }
            : {}),
          ...(studioDraftSync ? { studioDraftSync: true } : {}),
          ...(studioViewSync ? { studioViewSync: true } : {}),
          ...(audioTrimming ? { audioTrimming: true } : {}),
        },
        ...(plan?.features ? { features: plan.features } : {}),
        organizationChoice: {
          selectedBy: currentOrganizationSession()?.selected ? 'session' : 'credential',
          howToSwitch: switchHint(credential),
        },
      });
    },
  };
}
