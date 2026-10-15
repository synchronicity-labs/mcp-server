import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

const accountContext = z.object({
  account: z.object({ id: z.uuid(), email: z.email(), name: z.string().nullable() }).nullable(),
  organization: z.object({ id: z.uuid(), name: z.string(), role: z.string() }),
});

export function createAccountContextTool(http: HttpClient): McpToolDefinition {
  return {
    name: 'get-account-context',
    title: 'Read connected Sync account',
    description:
      'Read the authenticated account and selected organization for account display and personal asset scope. API keys have no signed-in account. This does not grant permissions or change the connected organization.',
    inputSchema: {},
    outputSchema: accountContext.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (_args, context) =>
      accountContext.parse(
        await http.request('get', '/v2/oauth/account', { signal: context?.signal }),
      ),
  };
}
