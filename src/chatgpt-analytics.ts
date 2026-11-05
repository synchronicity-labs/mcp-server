import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiRequestError, cameFromApi, type HttpClient } from './http-client.js';
import { schemaProperty } from './openapi/parser.js';
import type { ParsedOperation } from './openapi/types.js';
import {
  getToolAnalytics,
  runWithToolAnalytics,
  type ToolAttribution,
} from './tool-analytics-context.js';
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
// The API's names for these tools: the collector predates the tool rename, so events
// keep the legacy names (see legacyToolName in tool-names.ts).
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

/** Which tool events the API accepts, read from its published schema. */
export type ToolAnalytics = { tools: ReadonlySet<string>; errorDetails: boolean };

// The API rejects a whole event for an unknown tool or field, so new ones wait until
// the deployed API's schema lists them.
export function toolAnalyticsSupport(operations: ParsedOperation[]): ToolAnalytics | undefined {
  const operation = operations.find(
    (candidate) => candidate.operationId === 'analytics_captureChatgptEvent',
  );
  if (!operation) return undefined;
  const schema = operation.requestBody?.schema;
  const names = schemaProperty(schema, 'tool_name')?.enum;
  return {
    tools: new Set(
      Array.isArray(names) ? names.filter((name) => typeof name === 'string') : toolNames,
    ),
    errorDetails: ['error_source', 'error_status', 'error_code'].every((key) =>
      Boolean(schemaProperty(schema, key)),
    ),
  };
}

const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;

type ReportedError = { status?: unknown; code?: unknown } | undefined;

function errorCode(error: unknown, reported: ReportedError): unknown {
  if (error instanceof ApiRequestError) return error.code;
  if (error instanceof z.ZodError) return 'invalid_arguments';
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    return 'aborted';
  return reported?.code;
}

// Why a call failed, without its message: messages can echo user input.
function errorDetails(error: unknown, result: unknown) {
  const reported =
    result && typeof result === 'object' && 'structuredContent' in result
      ? (result.structuredContent as { error?: ReportedError } | undefined)?.error
      : undefined;
  const status = error instanceof ApiRequestError ? error.status : reported?.status;
  const code = errorCode(error, reported);
  return {
    error_source: cameFromApi(error) ? 'api' : 'mcp',
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? { error_status: status }
      : {}),
    ...(typeof code === 'string' && ERROR_CODE.test(code) ? { error_code: code } : {}),
  };
}

export async function trackToolExecution<T>(
  name: string,
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  profile: string,
  http: HttpClient,
  execute: (args: Record<string, unknown>) => Promise<T>,
  analytics?: ToolAnalytics,
): Promise<T> {
  const { syncAnalytics, ...businessArgs } = args;
  if (profile !== 'chatgpt') return execute(businessArgs);
  const ui = uiAnalyticsSchema.safeParse(syncAnalytics);
  const session = meta?.['openai/session'];
  const attribution: ToolAttribution = {
    version: 1,
    invocation_source: 'unknown',
    ...(ui.success ? ui.data : {}),
    ...(typeof session === 'string' && session.length <= 1024
      ? {
          conversation_id: createHash('sha256').update(session).digest('hex'),
        }
      : {}),
  };
  return runWithToolAnalytics(attribution, async () => {
    const started = performance.now();
    let outcome: 'success' | 'error' = 'error';
    let result: T | undefined;
    let failure: unknown;
    try {
      result = await execute(businessArgs);
      outcome =
        result && typeof result === 'object' && 'isError' in result && result.isError
          ? 'error'
          : 'success';
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (analytics?.tools.has(name) && attribution.invocation_source !== 'background') {
        void http
          .request('post', '/v2/analytics/chatgpt-events', {
            signal: AbortSignal.timeout(1500),
            body: {
              event: 'chatgpt_tool_called',
              event_id: randomUUID(),
              attribution,
              tool_name: name,
              outcome,
              duration_ms: Math.min(performance.now() - started, 3_600_000),
              ...(outcome === 'error' && analytics.errorDetails
                ? errorDetails(failure, result)
                : {}),
            },
          })
          .catch(() => undefined);
      }
    }
  });
}

export function createAnalyticsTool(http: HttpClient): McpToolDefinition {
  return {
    name: 'analytics_track-event',
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
      const attribution = getToolAnalytics();
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
