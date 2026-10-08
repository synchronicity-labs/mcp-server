import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

const accountContext = z.object({
  account: z
    .object({ id: z.uuid(), email: z.string().nullable(), name: z.string().nullable() })
    .nullable(),
  organization: z.object({ id: z.uuid(), name: z.string().nullable(), role: z.string() }),
});

export function createAccountContextTool(httpClient: HttpClient): McpToolDefinition {
  return {
    name: 'get-account-context',
    title: 'Connected Sync account',
    description:
      'Read the account and organization bound to this connection before selecting media or confirming paid generation. The organization receives usage charges. API-key connections may have no user identity. To change organizations, reconnect Sync and choose the intended organization; changing Studio alone does not change an OAuth connection.',
    inputSchema: {},
    outputSchema: {
      ...accountContext.partial().shape,
      error: z
        .object({ message: z.string(), status: z.number().optional() })
        .passthrough()
        .optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (_args, context) =>
      accountContext.parse(
        await httpClient.request('get', '/v2/oauth/account', { signal: context?.signal }),
      ),
  };
}
