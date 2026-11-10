import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runWithAuth } from '../auth/async-context.js';
import type { McpToolDefinition } from '../tools/index.js';
import { type TelemetryEvent, TelemetryQueue } from './queue.js';
import { TelemetrySession } from './session.js';
import { trackToolCall } from './tool-calls.js';

const OWNER = JSON.stringify(['user-1', 'client-1', null]);
const JOURNEY = '0b6c6a1e-3c5e-4a51-9f0e-4b7c2b1d9a10';

function setup(active = true) {
  const sent: TelemetryEvent[] = [];
  const queue = new TelemetryQueue(
    async (events) => void sent.push(...events),
    { maxEvents: 1000, batchSize: 1000, flushMs: 60_000, maxInFlight: 8 },
    active,
  );
  const session = (client = 'openai-mcp') => {
    const telemetry = new TelemetrySession(queue, 'http');
    telemetry.setClient(client, '1.0.0');
    return telemetry;
  };
  const drain = async () => {
    queue.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
    return sent.splice(0);
  };
  return { session, drain, queue };
}

const tool = (name: string, visibility?: string[]): McpToolDefinition => ({
  name,
  description: name,
  inputSchema: { idempotencyKey: z.string().optional() },
  ...(visibility && { meta: { ui: { visibility } } }),
  handler: async () => ({ status: 'COMPLETED' }),
});

function call(
  telemetry: TelemetrySession,
  definition: McpToolDefinition,
  args: Record<string, unknown> = {},
  meta?: Record<string, unknown>,
) {
  return runWithAuth(
    'token',
    'openai-mcp',
    () =>
      trackToolCall(telemetry, definition, args, { _meta: meta }, () =>
        definition.handler(args, undefined),
      ),
    OWNER,
  );
}

const steps = (events: TelemetryEvent[]) =>
  events.map(({ properties: p }) => [p.tool_name, p.call_index, p.previous_tool, p.invocation]);

describe('TelemetrySession across sessions', () => {
  it('orders calls by conversation when the client opens a session per call', async () => {
    const { session, drain } = setup();
    const chat = { 'openai/session': 'conversation-a' };
    const other = { 'openai/session': 'conversation-b' };
    await call(session(), tool('account_get-context'), {}, chat);
    await call(session(), tool('lipsync_create'), {}, chat);
    await call(session(), tool('projects_list'), {}, other);
    // The widget's own polling is not a step of the agent's conversation.
    await call(session(), tool('generations_get'), { syncAnalytics: background() }, chat);
    await call(session(), tool('generations_get'), {}, chat);
    const events = await drain();
    expect(steps(events)).toEqual([
      ['account_get-context', 1, undefined, 'model'],
      ['lipsync_create', 2, 'account_get-context', 'model'],
      ['projects_list', 1, undefined, 'model'],
      ['generations_get', 1, undefined, 'background'],
      ['generations_get', 3, 'lipsync_create', 'model'],
    ]);
    expect(events[1]!.properties.ms_since_previous_call).toEqual(expect.any(Number));
    expect(new Set(events.map((e) => e.properties.session_id)).size).toBe(5);
  });

  it('records widget-only calls as the widget’s, once per window for its own repeats', async () => {
    const { session, drain } = setup();
    const register = tool('studio-views_register', ['app']);
    // Codex runs the widget without its analytics, so no syncAnalytics arrives.
    for (let n = 0; n < 5; n += 1) await call(session('openai-mcp (codex)'), register);
    await call(session('openai-mcp (codex)'), register, { idempotencyKey: 'action-1' });
    await call(session('openai-mcp (codex)'), register, { idempotencyKey: 'action-2' });
    // Model-visible tools stay the model's, and are never thinned out.
    await call(session(), tool('generations_get', ['model', 'app']));
    await call(session(), tool('generations_get', ['model', 'app']));
    expect(steps(await drain())).toEqual([
      ['studio-views_register', 1, undefined, 'background'],
      ['studio-views_register', 1, undefined, 'ui'],
      ['studio-views_register', 1, undefined, 'ui'],
      ['generations_get', 1, undefined, 'model'],
      ['generations_get', 1, undefined, 'model'],
    ]);
  });

  it('keeps background reads of different targets apart', async () => {
    const { session, drain } = setup();
    const read = tool('generations_get', ['app']);
    const first = { id: '00000000-0000-4000-8000-000000000001' };
    const second = { id: '00000000-0000-4000-8000-000000000002' };
    for (const args of [first, second, first, second]) await call(session(), read, args);
    expect((await drain()).map((e) => e.properties.tool_name)).toEqual([
      'generations_get',
      'generations_get',
    ]);
  });

  it('does not count events dropped while waiting for the API as seen', async () => {
    const { session, drain, queue } = setup(false);
    const register = tool('studio-views_register', ['app']);
    const connect = () =>
      session().initialized({ protocolVersion: '2025-06-18', capabilities: {} }, OWNER, 'token');
    connect();
    await call(session(), register);
    queue.activate();
    connect();
    await call(session(), register);
    expect((await drain()).map((e) => e.event)).toEqual([
      'mcp_session_initialized',
      'mcp_tool_called',
    ]);
  });

  it('records a hosted client that reconnects for every call once per window', async () => {
    const { session, drain } = setup();
    const connect = (client: string, version = '2025-06-18') =>
      session(client).initialized({ protocolVersion: version, capabilities: {} }, OWNER, 'token');
    connect('openai-mcp (codex)');
    connect('openai-mcp (codex)');
    connect('openai-mcp');
    connect('openai-mcp (codex)', '2025-11-25');
    const events = await drain();
    expect(events.map((e) => [e.properties.client_name, e.properties.protocol_version])).toEqual([
      ['openai-mcp (codex)', '2025-06-18'],
      ['openai-mcp', '2025-06-18'],
      ['openai-mcp (codex)', '2025-11-25'],
    ]);
  });
});

function background() {
  return { version: 1, invocation_source: 'background', journey_id: JOURNEY };
}
