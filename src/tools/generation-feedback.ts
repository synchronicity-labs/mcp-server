import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

const input = z.object({ projectId: z.uuid(), generationId: z.uuid() });
const draft = z.object({
  feedbackType: z.enum(['upvote', 'downvote']),
  tags: z.array(z.string().max(100)).max(30).optional(),
  textFeedback: z.string().max(4000).nullable().optional(),
  textPending: z.boolean().optional(),
});
const row = z.object({
  generationId: z.uuid(),
  feedbackType: z.enum(['upvote', 'downvote']),
  tags: z.array(z.string()),
  textFeedback: z.string().nullable().optional(),
});

export function createGenerationFeedbackTools(http: HttpClient): McpToolDefinition[] {
  async function authorize(args: z.infer<typeof input>, signal?: AbortSignal) {
    const actor = z
      .object({ account: z.object({ id: z.uuid() }).nullable() })
      .parse(await http.request('get', '/v2/oauth/account', { signal }));
    if (!actor.account) throw new Error('Feedback requires a connected Sync account.');
    const project = z
      .object({ id: z.uuid() })
      .parse(await http.request('get', `/v2/projects/${args.projectId}`, { signal }));
    if (project.id !== args.projectId) throw new Error('Could not verify project access.');
    const page = z
      .object({
        items: z
          .array(z.object({ id: z.uuid(), projectId: z.uuid(), status: z.string() }))
          .length(1),
      })
      .parse(
        await http.request('get', '/v2/generations/list', {
          query: { projectId: args.projectId, ids: args.generationId, limit: '1' },
          signal,
        }),
      );
    const generation = page.items[0]!;
    if (
      generation.id !== args.generationId ||
      generation.projectId !== args.projectId ||
      !['COMPLETED', 'FAILED', 'REJECTED'].includes(generation.status)
    )
      throw new Error('Feedback requires an accessible finished generation in this project.');
  }
  return [false, true].map((write) => ({
    name: write ? 'submit-generation-feedback' : 'get-generation-feedback',
    title: write ? 'Save feedback on a Sync result' : 'Read your Sync result feedback',
    description: write
      ? 'Save an explicit rating and optional reasons on one accessible finished generation. Uses the connected account and team. Does not create media or generations. Free text may be analyzed by Sync.'
      : 'Read your own rating on one accessible finished generation after freshly checking project and generation access. Requires a signed-in account.',
    inputSchema: write ? input.extend(draft.shape).shape : input.shape,
    outputSchema: { feedback: row.nullable() },
    annotations: {
      readOnlyHint: !write,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: !write,
    },
    handler: async (raw, context) => {
      const args = input.parse(raw);
      const body = write ? draft.parse(raw) : undefined;
      await authorize(args, context?.signal);
      const feedback = row.nullable().parse(
        await http.request(
          write ? 'post' : 'get',
          `/v2/generations/${args.generationId}/feedback`,
          {
            ...(body
              ? {
                  body: {
                    ...body,
                    source: context?.clientProfile?.name === 'chatgpt' ? 'chatgpt' : 'mcp',
                  },
                }
              : {}),
            signal: context?.signal,
          },
        ),
      );
      if (feedback && feedback.generationId !== args.generationId)
        throw new Error('Feedback does not match this generation.');
      return { feedback };
    },
  }));
}
