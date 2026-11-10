import type { McpServer } from '@modelcontextprotocol/server';
import { uiAnalyticsSchema } from '../chatgpt-analytics.js';
import type { ToolRequestContext } from '../tools/generator.js';
import type { McpToolDefinition } from '../tools/index.js';
import { classifyOutcome } from './facets.js';
import type { CallContext, TelemetrySession } from './session.js';

/** Widget-only tools (ui.visibility without model) are never offered to the model. */
function widgetOnly(tool: McpToolDefinition): boolean {
  const ui = tool.meta?.ui;
  const visibility =
    ui && typeof ui === 'object' ? (ui as { visibility?: unknown }).visibility : undefined;
  return Array.isArray(visibility) && !visibility.includes('model');
}

/**
 * Who started the call. The widget names it in syncAnalytics where its analytics run
 * (ChatGPT); elsewhere, such as Codex, a widget-only tool's call still came from the
 * widget: a user action when it carries an idempotency key, the widget itself otherwise.
 */
function invocation(
  tool: McpToolDefinition,
  args: Record<string, unknown> | undefined,
): CallContext['invocation'] {
  const ui = uiAnalyticsSchema.safeParse(args?.syncAnalytics);
  if (ui.success) return ui.data.invocation_source;
  if (!widgetOnly(tool)) return 'model';
  return typeof args?.idempotencyKey === 'string' ? 'ui' : 'background';
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
      invocation: invocation(tool, args),
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
          invocation: invocation(definition, record),
        });
      }
      throw error;
    }
  };
}
