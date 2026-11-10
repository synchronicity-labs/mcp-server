import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';
import { TelemetrySession } from './telemetry/index.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';
import { translationSpec } from './test-fixtures/translation.js';

// What the MCP server sends to POST /v2/analytics/mcp-events, end to end through real
// tools against a stub API. See docs/telemetry.md for the contract checked here.
const CANARY = 'zq7canary';
const CANARY_TEXT = `${CANARY} please make Jane Doe say her card number 4242 4242`;
const CANARY_URL = `https://${CANARY}.invalid/${CANARY}.mp4?token=${CANARY}`;
const ID = '0b6c6a1e-3c5e-4a51-9f0e-4b7c2b1d9a10';
const videoAssetId = '00000000-0000-4000-8000-000000000002';

const mcpEvents = {
  '/v2/analytics/mcp-events': {
    post: { operationId: 'analytics_captureMcpEvents', tags: ['Analytics'] },
  },
};
const spec = {
  ...translationSpec,
  paths: {
    ...translationSpec.paths,
    ...mcpEvents,
    '/v2/generate/{id}': {
      get: {
        operationId: 'GenerateController_getGeneration',
        tags: ['Generate'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  },
};

type Sent = { headers: Record<string, string | string[] | undefined>; body: { events: Event[] } };
type Event = { event: string; event_id: string; timestamp: string; properties: Props };
type Props = Record<string, unknown> & { args?: Record<string, unknown> };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

/** Answers every request with a body full of canaries, and records telemetry batches. */
async function api(options: { collector?: boolean; failPaths?: RegExp } = {}) {
  const sent: Sent[] = [];
  const server = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') {
        const paths = { ...spec.paths } as Record<string, unknown>;
        if (options.collector === false) delete paths['/v2/analytics/mcp-events'];
        return void res.end(JSON.stringify({ ...spec, paths }));
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      if (req.url === '/v2/analytics/mcp-events') {
        sent.push({ headers: req.headers, body: JSON.parse(raw) });
        res.statusCode = 202;
        return void res.end('{}');
      }
      if (options.failPaths?.test(req.url ?? '')) {
        res.statusCode = 422;
        return void res.end(JSON.stringify({ errorCode: 'invalid_media', message: CANARY_TEXT }));
      }
      res.end(
        JSON.stringify({
          id: ID,
          status: 'COMPLETED',
          name: CANARY_TEXT,
          message: CANARY_TEXT,
          url: CANARY_URL,
          outputUrl: CANARY_URL,
          items: [{ id: ID, name: CANARY_TEXT }],
          limits: { concurrency: 2, maxOutputDurationSeconds: 600 },
        }),
      );
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sent };
}

async function connect(server: McpServer, name: string, version = '2.1.0') {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name, version });
  await client.connect(ct);
  cleanups.push(() => client.close().catch(() => {}));
  return client;
}

const events = (sent: Sent[]) => sent.flatMap((batch) => batch.body.events);
const calls = (sent: Sent[]) => events(sent).filter((e) => e.event === 'mcp_tool_called');
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
}

// What the API's validator accepts (docs/telemetry.md); anything else is a contract break.
const COMMON = [
  'session_id',
  'transport',
  'client_profile',
  'client_name',
  'client_version',
  'server_version',
  'server_revision',
];
const ALLOWED: Record<string, readonly string[]> = {
  mcp_session_initialized: [
    ...COMMON,
    'protocol_version',
    'client_capabilities',
    'toolsets',
    'spend_confirmation',
  ],
  mcp_tool_called: [
    ...COMMON,
    'call_id',
    'tool_name',
    'called_as',
    'call_index',
    'previous_tool',
    'ms_since_session_start',
    'ms_since_previous_call',
    'parent_call_id',
    'invocation',
    'outcome',
    'error_status',
    'error_code',
    'invalid_fields',
    'latency_ms',
    'args',
    'generation_id',
    'job_id',
    'batch_id',
    'project_id',
    'result_status',
    'result_count',
    'conversation_id',
    'locale',
    'country',
  ],
};
// The API's facet shapes (sync-api-v2 packages/validators/src/mcp-analytics.ts).
const ARG_VALUE =
  /^(?!.*:\/)[A-Za-z0-9][A-Za-z0-9_:/+-]{0,63}(?:\.[0-9][A-Za-z0-9_-]*)*$|^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?(?:,[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)+$/;

function expectContract(all: Event[]) {
  for (const { event, event_id, timestamp, properties } of all) {
    expect(Object.keys(ALLOWED)).toContain(event);
    expect(event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
    for (const key of Object.keys(properties)) expect(ALLOWED[event], key).toContain(key);
    for (const [key, value] of Object.entries(properties.args ?? {})) {
      expect(key).toMatch(/^[A-Za-z0-9_]{1,64}$/);
      if (typeof value === 'string') expect(value, key).toMatch(ARG_VALUE);
      else expect(['number', 'boolean']).toContain(typeof value);
    }
  }
}

// Schema-shaped arguments with a canary in every free-text slot.
function sample(schema: Record<string, unknown> | undefined, valid: boolean): unknown {
  if (!schema) return CANARY_TEXT;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const branches = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined;
  if (branches)
    return sample(
      branches.find((branch) => branch.type !== 'null'),
      valid,
    );
  switch (schema.type) {
    case 'string':
      if (schema.format === 'uuid') return valid ? ID : CANARY_TEXT;
      if (schema.format === 'uri' || schema.format === 'url') return CANARY_URL;
      if (schema.format === 'email') return `${CANARY}@example.com`;
      return CANARY_TEXT;
    case 'number':
    case 'integer':
      return (schema.minimum as number | undefined) ?? 1;
    case 'boolean':
      return true;
    case 'array': {
      const count = Math.max(1, (schema.minItems as number | undefined) ?? 1);
      return Array.from({ length: count }, () =>
        sample(schema.items as Record<string, unknown>, valid),
      );
    }
    default: {
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      return Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, sample(value, valid)]),
      );
    }
  }
}

async function callEveryTool(client: Client, run: <T>(fn: () => Promise<T>) => Promise<T>) {
  const { tools } = await run(() => client.listTools());
  await Promise.allSettled(
    tools.flatMap((tool) =>
      [true, false].map((valid) =>
        run(() =>
          client.callTool(
            {
              name: tool.name,
              arguments: sample(tool.inputSchema as Record<string, unknown>, valid) as Record<
                string,
                unknown
              >,
              _meta: {
                'openai/session': CANARY_TEXT,
                'openai/locale': 'es-ES',
                'openai/userLocation': { country: 'es', city: CANARY, region: CANARY },
              },
            },
            { timeout: 15_000 },
          ),
        ),
      ),
    ),
  );
  return tools.map((tool) => tool.name);
}

describe('usage telemetry over stdio', () => {
  it('records the session and each call in order, enough to answer the tracking plan', async () => {
    const { baseUrl, sent } = await api({ failPaths: /^\/v2\/generate\/estimate-cost/ });
    const server = await createSyncMcpServer({
      apiKey: 'key',
      baseUrl,
      transport: 'stdio',
      port: 0,
      updateCheck: false,
    });
    const client = await connect(server, 'Claude-Code');
    const dub = { videoAssetId, targetLang: 'es', model: 'sync-3' };
    await client.callTool({ name: 'dubbing_create', arguments: { ...dub, idempotencyKey: ID } });
    await client.callTool({
      name: 'dubbing_create',
      arguments: { ...dub, idempotencyKey: ID, videoAssetId: 7 },
    });
    await client.callTool({
      name: 'dubbing_create',
      arguments: { ...dub, idempotencyKey: ID, projectId: '00000000-0000-4000-8000-000000000009' },
    });
    await client.callTool({
      name: 'jobs_create-many',
      arguments: {
        tool: 'dubbing_create',
        idempotencyKey: ID,
        items: [dub, { ...dub, targetLang: 'fr' }],
      },
    });
    await client.close();
    await until(() => calls(sent).length >= 6);

    const all = events(sent);
    expectContract(all);
    // Sent with the process's own credential, never inside the body.
    for (const batch of sent) expect(batch.headers['x-api-key']).toBe('key');
    expect(JSON.stringify(all)).not.toContain('key"');

    const init = all.find((e) => e.event === 'mcp_session_initialized');
    expect(init?.properties).toMatchObject({
      transport: 'stdio',
      client_name: 'claude-code',
      client_version: '2.1.0',
      client_profile: 'generic',
    });
    const session = init!.properties.session_id;
    const own = calls(sent).filter((e) => e.properties.invocation !== 'nested');
    expect(own.every((e) => e.properties.session_id === session)).toBe(true);
    expect(
      own.map((e) => [e.properties.call_index, e.properties.tool_name, e.properties.previous_tool]),
    ).toEqual([
      [1, 'dubbing_create', undefined],
      [2, 'dubbing_create', 'dubbing_create'],
      [3, 'dubbing_create', 'dubbing_create'],
      [4, 'jobs_create-many', 'dubbing_create'],
    ]);
    expect(own.map((e) => e.properties.outcome)).toEqual([
      'success',
      'invalid_arguments',
      'refused',
      'success',
    ]);
    expect(own[0]!.properties).toMatchObject({
      generation_id: ID,
      args: { videoAssetId: 'uuid', targetLang: 'es', model: 'sync-3' },
    });
    expect(own[1]!.properties.invalid_fields).toEqual(['videoAssetId']);
    expect(own[2]!.properties).toMatchObject({ error_code: 'PROJECT_INTENT_REQUIRED' });

    const nested = calls(sent).filter((e) => e.properties.invocation === 'nested');
    expect(nested).toHaveLength(2);
    for (const call of nested) {
      expect(call.properties.parent_call_id).toBe(own[3]!.properties.call_id);
      expect(call.properties.call_index).toBeUndefined();
    }
  });

  it('sends nothing when turned off or before the API collects MCP events', async () => {
    for (const [config, collector] of [
      [{ telemetry: false }, true],
      [{}, false],
    ] as const) {
      const { baseUrl, sent } = await api({ collector });
      const server = await createSyncMcpServer({
        apiKey: 'key',
        baseUrl,
        transport: 'stdio',
        port: 0,
        updateCheck: false,
        ...config,
      });
      const client = await connect(server, 'cursor');
      await client.callTool({
        name: 'dubbing_create',
        arguments: { videoAssetId, targetLang: 'es', model: 'sync-3' },
      });
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sent).toEqual([]);
    }
  });

  it('leaks no argument, result or error text from any tool', async () => {
    const { baseUrl, sent } = await api({ failPaths: /estimate|voices|assets/ });
    const server = await createSyncMcpServer({
      apiKey: 'key',
      baseUrl,
      transport: 'stdio',
      port: 0,
      updateCheck: false,
      toolsets: ['all'],
    });
    const client = await connect(server, 'cursor');
    const names = await callEveryTool(client, (fn) => fn());
    await client.close();
    await until(() => new Set(calls(sent).map((e) => e.properties.tool_name)).size >= names.length);

    expectContract(events(sent));
    expect(JSON.stringify(sent.map((batch) => batch.body))).not.toContain(CANARY);
    // Every tool reported at least one call, so the scan above covered all of them.
    expect(new Set(calls(sent).map((e) => e.properties.tool_name))).toEqual(new Set(names));
  }, 60_000);
});

describe('usage telemetry on the hosted server', () => {
  it('waits, inactive, when it starts before the API collects MCP events', async () => {
    const { baseUrl, sent } = await api({ collector: false });
    const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
    expect(factory.telemetry?.stats()).toMatchObject({ active: false });
    const telemetry = new TelemetrySession(factory.telemetry!, 'http');
    telemetry.setClient('openai-mcp', '1.0.0');
    telemetry.initialized({ protocolVersion: '2025-06-18', capabilities: {} }, 'owner', 'token');
    factory.telemetry!.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toEqual([]);
  });

  it('sends each owner’s events with that owner’s token and keeps ChatGPT context coarse', async () => {
    const { baseUrl, sent } = await api({ failPaths: /estimate|voices|assets/ });
    const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
    expect(factory.telemetry).toBeDefined();
    const telemetry = new TelemetrySession(factory.telemetry!, 'http');
    telemetry.setClient('openai-mcp', '1.0.0');
    const server = factory.createServer(undefined, 'openai-mcp', telemetry);
    const owner = JSON.stringify(['user-1', 'client-1', null]);
    const run = <T>(fn: () => Promise<T>) => runWithAuth('fixture-token', 'openai-mcp', fn, owner);
    const client = await run(() => connect(server, 'openai-mcp'));
    telemetry.initialized(
      { protocolVersion: '2025-06-18', capabilities: {} },
      owner,
      'fixture-token',
    );
    // The hosted server's own failure log lines must not carry call content either.
    const logged: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
    let names: string[];
    try {
      names = await callEveryTool(client, run);
    } finally {
      write.mockRestore();
    }
    expect(logged.some((line) => line.includes('"mcp_tool_error"'))).toBe(true);
    expect(logged.join('')).not.toContain(CANARY);
    factory.telemetry!.flush();
    await until(() => new Set(calls(sent).map((e) => e.properties.tool_name)).size >= names.length);

    const all = events(sent);
    expectContract(all);
    expect(JSON.stringify(sent.map((batch) => batch.body))).not.toContain(CANARY);
    for (const batch of sent) expect(batch.headers.authorization).toBe('Bearer fixture-token');
    // Calls the SDK rejects never reach a handler, so they carry no _meta.
    const call = calls(sent).find((e) => e.properties.outcome !== 'invalid_arguments')!;
    expect(call.properties).toMatchObject({
      transport: 'http',
      client_profile: 'chatgpt',
      locale: 'es-ES',
      country: 'ES',
    });
    expect(call.properties.conversation_id).toMatch(/^[a-f0-9]{64}$/);
    expect(all.filter((e) => e.event === 'mcp_session_initialized')).toHaveLength(1);
  }, 60_000);
});
