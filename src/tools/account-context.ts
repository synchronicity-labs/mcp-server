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
  capabilities: z.object({
    projectRenaming: z.literal(true),
    chatgptAnalytics: z.literal(true).optional(),
    studioDraftSync: z.literal(true).optional(),
    studioViewSync: z.literal(true).optional(),
    audioTrimming: z.literal(true).optional(),
  }),
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
      'Read the authenticated account and selected organization for account display and personal asset scope, team seats and voice-clone limits. API keys have no signed-in account. This does not grant permissions or change the connected organization.',
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
      let limits: unknown;
      try {
        limits = await http.request('get', '/v2/plans/limits', {
          signal: context?.signal,
        });
      } catch (error) {
        context?.signal?.throwIfAborted();
        // A limits outage must not erase verified identity; expired credentials still need linking.
        if (error instanceof ApiRequestError && error.status === 401) throw error;
      }
      return accountContext.parse({
        ...z
          .object({
            account: accountContext.shape.account,
            organization: accountContext.shape.organization,
          })
          .parse(identity),
        ...(limits === undefined ? {} : { limits }),
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
