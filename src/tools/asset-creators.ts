import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

const member = z.object({
  userId: z.uuid(),
  user: z
    .object({
      id: z.uuid(),
      displayName: z.string().nullable(),
      email: z.string().nullable(),
      avatarUrl: z.string().nullable(),
    })
    .nullish(),
});

export function createAssetCreatorsTool(http: HttpClient): McpToolDefinition {
  return {
    name: 'get-asset-creators',
    title: 'Read Sync asset creators',
    description:
      "Read the connected organization's members (display name, email and avatar) for the Sync interface's asset creator filter. Organization scope is resolved from the authenticated connection.",
    // The creator filter needs member emails; keep them out of the model's context.
    meta: { ui: { visibility: ['app'] } },
    inputSchema: {},
    outputSchema: { members: member.array() },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (_args, context) => {
      const identity = z
        .object({ organization: z.object({ id: z.uuid() }) })
        .parse(await http.request('get', '/v2/oauth/account', { signal: context?.signal }));
      const members = member.array().parse(
        await http.request('get', `/v2/organizations/${identity.organization.id}/members`, {
          signal: context?.signal,
        }),
      );
      return { members };
    },
  };
}
