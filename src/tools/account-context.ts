import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

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
});

// GET /v2/account: the plan and the limits a job has to fit, including organization overrides.
const accountOverview = z.object({
  plan: accountContext.shape.plan,
  limits: z
    .object({
      concurrency: z.number().finite().nonnegative(),
      maxOutputDurationSeconds: z.number().finite().nonnegative(),
    })
    .optional(),
});

export function createAccountContextTool(
  http: HttpClient,
  studioDraftSync = false,
  studioViewSync = false,
  audioTrimming = false,
  chatgptAnalytics = false,
): McpToolDefinition {
  return {
    name: 'get-account-context',
    title: 'Read connected Sync account',
    description:
      'Read the authenticated account and selected organization for account display and personal asset scope, its plan, generation limits (concurrency and longest output), team seats and voice-clone limits. API keys have no signed-in account. This does not grant permissions or change the connected organization.',
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
      const overview = await optional('/v2/account');
      const plan = accountOverview.safeParse(overview).data;
      return accountContext.parse({
        ...z
          .object({
            account: accountContext.shape.account,
            organization: accountContext.shape.organization,
          })
          .parse(identity),
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
      });
    },
  };
}
