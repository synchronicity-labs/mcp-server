import { type EventEmitter, once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/server';
import express from 'express';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { startHttpServer } from './http-server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

const heap = vi.hoisted(() => ({ used_heap_size: 20, heap_size_limit: 100 }));
vi.mock('node:v8', () => ({ getHeapStatistics: () => heap }));

// Exercise hosted verification and session dispatch with an SDK tool that exposes cancellation.
// All credentials and userinfo responses are local test fixtures.
let upstream: Server | undefined;
let hosted: Server | undefined;
let url: string;
const events = ['SIGINT', 'SIGTERM', 'uncaughtExceptionMonitor', 'warning', 'exit'] as const;
const emitter: EventEmitter = process;
const previous = new Map<string, ReturnType<EventEmitter['listeners']>>();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let started = deferred<void>();
let aborted = false;
let activeHolds = 0;
let clockOffset = 0;
let release = deferred<void>();
beforeAll(async () => {
  vi.stubEnv('MCP_MAX_IN_FLIGHT_REQUESTS', '2');
  const realNow = Date.now;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  for (const event of events) previous.set(event, emitter.listeners(event));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  upstream = createServer(
    asyncRequestListener(async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
      const token = req.headers.authorization;
      res.setHeader('Content-Type', 'application/json');
      if (path === '/v2/oauth/userinfo') {
        const kind = token?.replace('Bearer ', '');
        res.end(
          JSON.stringify({
            sub: kind === 'foreign-sub' ? 'other' : 'owner',
            client_id: kind === 'foreign-client' ? 'other' : 'client',
            ...(kind === 'missing-org'
              ? {}
              : { organization_id: kind === 'foreign-org' ? 'other' : 'org' }),
            expires_at: 4000000000,
          }),
        );
        return;
      }
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
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'http' as const,
    port: 0,
  };
  await startHttpServer(
    {
      toolCount: 1,
      createServer: () => {
        const server = new McpServer({ name: 'ownership-fixture', version: '1' });
        server.registerTool('hold', { inputSchema: z.object({}) }, async (_args, context) => {
          activeHolds++;
          started.resolve();
          const onAbort = () => {
            aborted = true;
            release.resolve();
          };
          context.mcpReq.signal.addEventListener('abort', onAbort, { once: true });
          try {
            await release.promise;
            return { content: [{ type: 'text' as const, text: 'completed' }] };
          } finally {
            activeHolds--;
            context.mcpReq.signal.removeEventListener('abort', onAbort);
          }
        });
        return server;
      },
    },
    config,
  );
  if (!hosted) throw new Error('Hosted fixture did not start');
  url = `http://127.0.0.1:${(hosted.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => {
  release.resolve();
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
    for (const event of events)
      for (const listener of emitter.listeners(event))
        if (!previous.get(event)?.includes(listener))
          emitter.removeListener(event, listener as (...args: unknown[]) => void);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

async function request(
  sessionId: string | undefined,
  token: string,
  method: string,
  body?: unknown,
  signal?: AbortSignal,
) {
  return fetch(url, {
    method,
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-03-26',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function initialize(token = 'owner') {
  const response = await request(undefined, token, 'POST', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'fixture', version: '1' },
    },
  });
  expect(response.status).toBe(200);
  await response.text();
  const id = response.headers.get('mcp-session-id')!;
  expect(id).toBeTruthy();
  const initialized = await request(id, token, 'POST', {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  expect(initialized.status).toBe(202);
  await initialized.text();
  return id;
}
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
it.each(['foreign-sub', 'foreign-client', 'foreign-org', 'missing-org'])(
  'blocks %s reuse, SSE and deletion while allowing owner refresh',
  async (token) => {
    const id = await initialize();
    for (const method of ['POST', 'GET', 'DELETE']) {
      const denied = await request(id, token, method, method === 'POST' ? list : undefined);
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual({ error: 'Session not found' });
    }
    const refreshed = await request(id, 'owner-refreshed', 'POST', list);
    expect(refreshed.status).toBe(200);
    expect(await refreshed.text()).toContain('hold');
    const deleted = await request(id, 'owner-refreshed', 'DELETE');
    expect(deleted.status).toBe(200);
    await deleted.text();
    const gone = await request(id, 'owner', 'POST', list);
    expect(gone.status).toBe(404);
    await gone.text();
  },
);
it('rejects foreign cancellation and accepts cancellation by a refreshed owner token', async () => {
  started = deferred<void>();
  release = deferred<void>();
  aborted = false;
  const id = await initialize();
  const stop = new AbortController();
  const pending = request(
    id,
    'owner',
    'POST',
    {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'hold', arguments: {} },
    },
    stop.signal,
  )
    .then((response) => response.text())
    .catch(() => undefined);
  await started.promise;
  const cancellation = {
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 20, reason: 'fixture' },
  };
  for (const token of ['foreign-sub', 'foreign-client', 'foreign-org', 'missing-org']) {
    const denied = await request(id, token, 'POST', cancellation);
    expect(denied.status).toBe(404);
    await denied.text();
    expect(aborted).toBe(false);
  }
  const accepted = await request(id, 'owner-refreshed', 'POST', cancellation);
  expect(accepted.status).toBe(202);
  await accepted.text();
  await vi.waitFor(() => expect(aborted).toBe(true));
  stop.abort();
  await pending;
  const response = await request(id, 'owner-refreshed', 'DELETE');
  await response.text();
});

it('treats an absent organization as an exact legacy identity, never a wildcard', async () => {
  const id = await initialize('missing-org');
  const denied = await request(id, 'owner', 'POST', list);
  expect(denied.status).toBe(404);
  await denied.text();
  const allowed = await request(id, 'missing-org', 'POST', list);
  expect(allowed.status).toBe(200);
  await allowed.text();
  await (await request(id, 'missing-org', 'DELETE')).text();
});

it('returns retryable 503 before allocation under heap pressure, and refuses new request graphs on existing sessions', async () => {
  const id = await initialize();
  try {
    heap.used_heap_size = 60;
    const response = await request(undefined, 'owner', 'POST', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'fixture', version: '1' },
      },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toEqual({ error: 'MCP session capacity reached' });
    const existing = await request(id, 'owner-refreshed', 'POST', list);
    expect(existing.status).toBe(503);
    expect(await existing.json()).toEqual({ error: 'MCP request capacity reached' });
  } finally {
    heap.used_heap_size = 20;
  }
  const recovered = await initialize();
  for (const sessionId of [id, recovered]) {
    const response = await request(sessionId, 'owner', 'DELETE');
    expect(response.status).toBe(200);
    await response.text();
  }
});

it('exposes authenticated aggregate capacity without leaking session identities', async () => {
  const endpoint = url.replace(/\/mcp$/, '/status');
  expect((await fetch(endpoint)).status).toBe(401);
  const response = await fetch(endpoint, { headers: { Authorization: 'Bearer owner' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const status = await response.json();
  expect(status).toMatchObject({
    sessions: {
      limit: 1000,
      rejectedCapacity: expect.any(Number),
      rejectedMemory: expect.any(Number),
    },
    memory: { heapLimitBytes: expect.any(Number) },
  });
  expect(JSON.stringify(status)).not.toMatch(/subject|organization|clientId|token/);
});

it('expires abandoned HTTP sessions while preserving a running tool and allowing reinitialization', async () => {
  started = deferred<void>();
  release = deferred<void>();
  aborted = false;
  const idle = await initialize();
  const active = await initialize();
  const pending = request(active, 'owner', 'POST', {
    jsonrpc: '2.0',
    id: 30,
    method: 'tools/call',
    params: { name: 'hold', arguments: {} },
  });
  await started.promise;
  clockOffset = 120_001;
  try {
    const expired = await request(idle, 'owner', 'POST', list);
    expect(expired.status).toBe(404);
    await expired.text();
    const replacement = await initialize();
    expect(aborted).toBe(false);
    release.resolve();
    const completed = await pending;
    expect(completed.status).toBe(200);
    expect(await completed.text()).toContain('completed');
    const resumed = await request(active, 'owner', 'POST', list);
    expect(resumed.status).toBe(200);
    await resumed.text();
    for (const id of [active, replacement]) await (await request(id, 'owner', 'DELETE')).text();
  } finally {
    release.resolve();
    clockOffset = 0;
  }
});

it('does not allocate sessions for invalid initialization or unsolicited streams', async () => {
  const stats = async () => {
    const response = await fetch(new URL('/status', url), {
      headers: { Authorization: 'Bearer owner' },
    });
    return z
      .object({ sessions: z.object({ created: z.number(), inFlight: z.number() }) })
      .parse(await response.json());
  };
  const before = await stats();
  for (const [method, body, status] of [
    ['GET', undefined, 405],
    ['POST', list, 400],
    ['POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 400],
  ] as const) {
    const response = await request(undefined, 'owner', method, body);
    expect(response.status).toBe(status);
    await response.text();
  }
  expect((await stats()).sessions.created).toBe(before.sessions.created);
  const id = await initialize();
  const response = await request(id, 'owner', 'GET');
  expect(response.status).toBe(405);
  await response.text();
  expect((await stats()).sessions.inFlight).toBe(0);
  await (await request(id, 'owner', 'DELETE')).text();
});

it('bounds concurrent request graphs without aborting work already admitted', async () => {
  release = deferred<void>();
  const id = await initialize();
  const pending = [40, 41].map((requestId) =>
    request(id, 'owner', 'POST', {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: { name: 'hold', arguments: {} },
    })
      .then((response) => response.text())
      .catch(() => undefined),
  );
  try {
    await vi.waitFor(() => expect(activeHolds).toBe(2));
    const refused = await request(id, 'owner', 'POST', list);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('60');
    await refused.text();
    expect(activeHolds).toBe(2);
    const notification = await request(id, 'owner', 'POST', {
      jsonrpc: '2.0',
      method: 'notifications/unknown',
    });
    expect(notification.status).toBe(503);
    await notification.text();
    const cleanup = await request(id, 'owner', 'POST', [
      {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 40 },
      },
    ]);
    expect(cleanup.status).toBe(202);
    await cleanup.text();
    await vi.waitFor(() => expect(activeHolds).toBe(0));
  } finally {
    release.resolve();
    await Promise.all(pending);
    await (await request(id, 'owner', 'DELETE')).text();
  }
});
