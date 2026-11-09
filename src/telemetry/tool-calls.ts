import type { McpServer } from '@modelcontextprotocol/server';
import { uiAnalyticsSchema } from '../chatgpt-analytics.js';
import type { ToolRequestContext } from '../tools/generator.js';
import type { McpToolDefinition } from '../tools/index.js';
import { classifyOutcome } from './facets.js';
import type { CallContext, TelemetrySession } from './session.js';

function invocation(args: Record<string, unknown> | undefined): CallContext['invocation'] {
  const ui = uiAnalyticsSchema.safeParse(args?.syncAnalytics);
  return ui.success ? ui.data.invocation_source : 'model';
}

/** Runs one tool call through the session's recorder. */
export function trackToolCall<T>(
  telemetry: TelemetrySession,
  tool: McpToolDefinition,
  args: Record<string, unknown>,
  context: ToolRequestContext | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return telemetry.track(
    {
      tool: tool.name,
      calledAs: context?.calledAs,
      shape: tool.inputSchema,
      args,
      meta: context?._meta,
      invocation: invocation(args),
    },
    run,
    (error, result) => classifyOutcome(error, result, context?.signal),
  );
}

type Validator = (tool: unknown, args: unknown, name: string) => Promise<unknown>;

/**
 * Records calls the SDK rejects for invalid arguments before any handler runs. The SDK
 * keeps this step private; a test fails if an upgrade moves it.
 */
export function observeRejectedCalls(
  server: McpServer,
  telemetry: TelemetrySession | undefined,
  callableTools: () => ReadonlyMap<string, McpToolDefinition>,
): void {
  const target = server as unknown as { validateToolInput?: Validator };
  const validate = target.validateToolInput;
  if (!telemetry || typeof validate !== 'function') return;
  const toolsByName = callableTools();
  target.validateToolInput = async (tool, args, name) => {
    try {
      return await validate.call(server, tool, args, name);
    } catch (error) {
      const definition = toolsByName.get(name);
      if (definition) {
        const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
        telemetry.rejected({
          tool: definition.name,
          calledAs: name,
          shape: definition.inputSchema,
          args: record,
          meta: undefined,
          invocation: invocation(record),
        });
      }
      throw error;
    }
  };
}
