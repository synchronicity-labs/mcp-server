import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

const accountContext = z.object({
  account: z
    .object({ id: z.uuid(), email: z.string().nullable(), name: z.string().nullable() })
    .nullable(),
  limits: z.object({
    seats: z.number().finite().nonnegative(),
    voiceClone: z.number().finite().nonnegative(),
  }),
  organization: z.object({ id: z.uuid(), name: z.string().nullable(), role: z.string() }),
  capabilities: z.object({
    projectRenaming: z.literal(true),
    embeddedVoiceCloning: z.boolean(),
    generationFeedback: z.literal(true),
  }),
});

export function createAccountContextTool(
  http: HttpClient,
  embeddedVoiceCloning = false,
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
      const identity = await http.request('get', '/v2/oauth/account', { signal: context?.signal });
      const limits = await http.request('get', '/v2/plans/limits', { signal: context?.signal });
      return accountContext.parse({
        ...z
          .object({
            account: accountContext.shape.account,
            organization: accountContext.shape.organization,
          })
          .parse(identity),
        limits,
        capabilities: { projectRenaming: true, embeddedVoiceCloning, generationFeedback: true },
      });
    },
  };
}
