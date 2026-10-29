import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { HttpClient } from './http-client.js';
import type { McpToolDefinition } from './tools/generator.js';

export const uiAnalyticsSchema = z
  .object({
    version: z.literal(1),
    invocation_source: z.enum(['ui', 'background']),
    journey_id: z.uuid(),
    action_id: z.uuid().optional(),
  })
  .strict();

const attributionSchema = uiAnalyticsSchema.extend({
  invocation_source: z.enum(['model', 'ui', 'background', 'unknown']),
  journey_id: z.uuid().optional(),
  conversation_id: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
type Attribution = z.infer<typeof attributionSchema>;
const context = new AsyncLocalStorage<Attribution>();
const toolNames = [
  'open-sync-app',
  'create-lipsync',
  'create-lipsync-from-assets',
  'create-translate-and-dub',
  'create-dialogue-video',
  'update-studio-draft',
  'open-studio-project',
] as const;
const eventSchema = z
  .object({
    event: z.enum([
      'chatgpt_ui_loaded',
      'chatgpt_project_opened',
      'chatgpt_asset_selected',
      'chatgpt_generate_clicked',
      'chatgpt_tool_called',
    ]),
    event_id: z.uuid(),
    attribution: attributionSchema,
    tool_name: z.enum(toolNames).optional(),
    outcome: z.enum(['success', 'error']).optional(),
    duration_ms: z.number().finite().nonnegative().max(3_600_000).optional(),
  })
  .strict();

export function getToolAnalytics(): Attribution | undefined {
  return context.getStore();
}

export async function trackToolExecution<T>(
  name: string,
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  profile: string,
  http: HttpClient,
  execute: (args: Record<string, unknown>) => Promise<T>,
  enabled = true,
): Promise<T> {
  const { syncAnalytics, ...businessArgs } = args;
  if (profile !== 'chatgpt') return execute(businessArgs);
  const ui = uiAnalyticsSchema.safeParse(syncAnalytics);
  const session = meta?.['openai/session'];
  const attribution: Attribution = {
    version: 1,
    invocation_source: 'unknown',
    ...(ui.success ? ui.data : {}),
    ...(typeof session === 'string' && session.length <= 1024
      ? {
          conversation_id: createHash('sha256').update(session).digest('hex'),
        }
      : {}),
  };
  return context.run(attribution, async () => {
    const started = performance.now();
    let outcome: 'success' | 'error' = 'error';
    try {
      const result = await execute(businessArgs);
      outcome =
        result && typeof result === 'object' && 'isError' in result && result.isError
          ? 'error'
          : 'success';
      return result;
    } finally {
      const tool = z.enum(toolNames).safeParse(name);
      if (enabled && tool.success && attribution.invocation_source !== 'background') {
        void http
          .request('post', '/v2/analytics/chatgpt-events', {
            signal: AbortSignal.timeout(1500),
            body: {
              event: 'chatgpt_tool_called',
              event_id: randomUUID(),
              attribution,
              tool_name: tool.data,
              outcome,
              duration_ms: Math.min(performance.now() - started, 3_600_000),
            },
          })
          .catch(() => undefined);
      }
    }
  });
}

export function createAnalyticsTool(http: HttpClient): McpToolDefinition {
  return {
    name: 'track-chatgpt-event',
    title: 'Record Sync interface interaction',
    description:
      'Record bounded interface telemetry for the authenticated Sync user. No prompts, media, credentials or account identifiers are accepted.',
    inputSchema: eventSchema.shape,
    outputSchema: { accepted: z.boolean() },
    meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private' },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    handler: async (args) => {
      const event = eventSchema.parse(args);
      const attribution = context.getStore();
      await http.request('post', '/v2/analytics/chatgpt-events', {
        signal: AbortSignal.timeout(1500),
        body: {
          ...event,
          attribution: {
            ...event.attribution,
            ...(attribution?.conversation_id && { conversation_id: attribution.conversation_id }),
          },
        },
      });
      return { accepted: true };
    },
  };
}
