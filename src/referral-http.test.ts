import { type EventEmitter, once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { startHttpServer } from './http-server.js';
import { createMcpServerFactory } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';
import { referralCollectorSchema } from './test-fixtures/telemetry.js';

const batchSchema = z.object({
  events: z.array(
    z.object({
      event: z.enum(['mcp_session_initialized', 'mcp_tool_called']),
      properties: z.record(z.string(), z.unknown()),
    }),
  ),
});
const sent: z.infer<typeof batchSchema>['events'] = [];
const spec = {
  openapi: '3.1.0',
  paths: {
    '/v2/models': { get: { operationId: 'ModelsController_get', tags: ['models'] } },
    '/v2/analytics/mcp-events': {
      post: {
        operationId: 'analytics_captureMcpEvents',
        tags: ['Analytics'],
        requestBody: { content: { 'application/json': { schema: referralCollectorSchema() } } },
      },
    },
  },
};
const processEvents = ['SIGINT', 'SIGTERM', 'uncaughtExceptionMonitor', 'warning', 'exit'] as const;
const emitter: EventEmitter = process;
const previous = new Map<string, ReturnType<EventEmitter['listeners']>>();
let upstream: Server | undefined;
let hosted: Server | undefined;
let factory: Awaited<ReturnType<typeof createMcpServerFactory>>;
let url: string;

function origin(server: Server): string {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a port');
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  sent.length = 0;
  for (const event of processEvents) previous.set(event, emitter.listeners(event));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  upstream = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') return void res.end(JSON.stringify(spec));
      if (req.url === '/v2/oauth/userinfo')
        return void res.end(
          JSON.stringify({
            sub: 'fixture-user',
            client_id: 'fixture-client',
            expires_at: 4000000000,
          }),
        );
      if (req.url === '/v2/analytics/mcp-events') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        sent.push(...batchSchema.parse(JSON.parse(raw)).events);
        res.statusCode = 204;
        return void res.end();
      }
      if (req.url === '/v2/models') return void res.end(JSON.stringify([{ name: 'sync-3' }]));
      res.statusCode = 404;
      res.end('{}');
    }),
  );
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const listen = express.application.listen;
  vi.spyOn(express.application, 'listen').mockImplementation(function (
    this: express.Application,
    ...args: Parameters<typeof listen>
  ) {
    hosted = listen.apply(this, args);
    return hosted;
  });
  const config = {
    baseUrl: origin(upstream),
    transport: 'http' as const,
    port: 0,
    referralSource: 'server-config-must-not-leak',
  };
  factory = await createMcpServerFactory(config);
  await startHttpServer(factory, config);
  if (!hosted) throw new Error('Hosted fixture did not start');
  url = `${origin(hosted)}/mcp`;
});

afterEach(async () => {
  try {
    if (hosted?.listening) {
      const closed = once(hosted, 'close');
      for (const listener of emitter.listeners('SIGTERM'))
        if (!previous.get('SIGTERM')?.includes(listener)) listener('SIGTERM');
      hosted.closeAllConnections();
      await closed;
    }
  } finally {
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    }
    for (const event of processEvents)
      for (const listener of emitter.listeners(event))
        if (!previous.get(event)?.includes(listener))
          emitter.removeListener(event, listener as (...args: unknown[]) => void);
    vi.restoreAllMocks();
  }
});

function rpc(body: unknown, sessionId?: string, referral?: string | string[]) {
  return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer fixture-token',
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'MCP-Protocol-Version': '2025-03-26',
            ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
            ...(referral !== undefined ? { 'X-MCP-Referral': referral } : {}),
          },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (raw += chunk));
          res.on('error', reject);
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    },
  );
}

async function initialize(referral?: string | string[]) {
  const response = await rpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'openai-mcp', version: '1.0.0' },
      },
    },
    undefined,
    referral,
  );
  expect(response.status).toBe(200);
  const sessionId = z.string().min(1).parse(response.headers['mcp-session-id']);
  const ready = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
  expect(ready.status).toBe(202);
  return sessionId;
}

async function call(sessionId: string, referral?: string | string[]) {
  const response = await rpc(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'models_list', arguments: {} } },
    sessionId,
    referral,
  );
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({ result: { content: expect.any(Array) } });
  expect(JSON.parse(response.body).result.isError).not.toBe(true);
}

async function flush(count: number) {
  if (!factory.telemetry) throw new Error('Fixture collector was not discovered');
  factory.telemetry.flush();
  await vi.waitFor(() => expect(sent).toHaveLength(count));
  await vi.waitFor(() => expect(factory.telemetry?.stats().inFlight).toBe(0));
}

it('captures initialization referral once and isolates sessions without changing the client', async () => {
  const first = await initialize('  GLaMA  ');
  const second = await initialize('Smithery');
  await call(first, 'replacement');
  await call(second);
  await call(first, 'smithery');
  await flush(5);

  const initialized = sent.filter((event) => event.event === 'mcp_session_initialized');
  expect(initialized.map((event) => event.properties.referral_source)).toEqual([
    'glama',
    'smithery',
  ]);
  expect(new Set(initialized.map((event) => event.properties.session_id)).size).toBe(2);
  for (const event of sent)
    expect(event.properties).toMatchObject({
      transport: 'http',
      client_profile: 'chatgpt',
      client_name: 'openai-mcp',
    });
  for (const [index, referral] of ['glama', 'smithery'].entries()) {
    const session = initialized[index]!.properties.session_id;
    const own = sent.filter((event) => event.properties.session_id === session);
    expect(own).toHaveLength(index === 0 ? 3 : 2);
    for (const event of own) expect(event.properties.referral_source).toBe(referral);
  }
});

it.each([
  { label: 'absent', referral: undefined },
  { label: 'invalid URL', referral: 'https://glama.ai' },
  { label: 'oversized', referral: 'a'.repeat(33) },
  { label: 'duplicate', referral: ['glama', 'glama'] },
])('omits $label referral without using later headers or server config', async ({ referral }) => {
  const session = await initialize(referral);
  await call(session, 'late-referral');
  await flush(2);
  expect(sent.map((event) => event.event)).toEqual(['mcp_session_initialized', 'mcp_tool_called']);
  for (const event of sent) {
    expect(event.properties).not.toHaveProperty('referral_source');
    expect(event.properties).toMatchObject({
      client_profile: 'chatgpt',
      client_name: 'openai-mcp',
    });
  }
});
