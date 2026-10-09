import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appUploadHandler, relayUploadTool } from './app-upload-relay.js';
import {
  createReplicaId,
  createReplicaRouter,
  getReplicaRoutingConfig,
} from './replica-routing.js';
import { SessionRegistry } from './session-registry.js';

const network = vi.hoisted(() => ({
  ports: new Map<string, number>(),
  targets: [] as string[],
  headers: [] as import('node:http').RequestOptions['headers'][],
  storagePort: 0,
}));
vi.mock('node:http', async () => {
  const actual = await vi.importActual<typeof import('node:http')>('node:http');
  return {
    ...actual,
    request: (
      options: import('node:http').RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      network.targets.push(String(options.hostname));
      network.headers.push(options.headers ?? {});
      const port = network.ports.get(String(options.hostname));
      if (!port) throw new Error('Unexpected network destination');
      return actual.request({ ...options, hostname: '127.0.0.1', port }, callback);
    },
  };
});
vi.mock('node:https', async () => {
  const actual = await vi.importActual<typeof import('node:http')>('node:http');
  return {
    request: (
      _url: string,
      options: import('node:http').RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) =>
      actual.request(
        { ...options, hostname: '127.0.0.1', port: network.storagePort, path: '/object' },
        callback,
      ),
  };
});
const servers: Server[] = [];
const registries: SessionRegistry<StreamableHTTPServerTransport>[] = [];
const addresses = Array.from({ length: 5 }, (_, i) => `10.10.0.${i + 1}`);
const seen: string[] = [];
const peerState = { addresses: [...addresses], fails: false };
const owner = { sub: 'user', clientId: 'client', organizationId: 'org' };
let aborted = false;
let paidCalls = 0;
let holdStarted: () => void;
let holdPromise: Promise<void>;
let urls: string[];
let putCount = 0;
let putBytes = '';
let uploadOwner = '';
async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return server;
}
const discover = async () => {
  if (peerState.fails) throw new Error('DNS unavailable');
  return peerState.addresses;
};
beforeEach(async () => {
  peerState.addresses = [...addresses];
  peerState.fails = false;
  network.targets.length = 0;
  network.headers.length = 0;
  network.ports.clear();
  seen.length = 0;
  aborted = false;
  paidCalls = 0;
  putCount = 0;
  putBytes = '';
  uploadOwner = '';
  holdPromise = new Promise<void>((resolve) => {
    holdStarted = resolve;
  });
  const storage = express();
  storage.put('/object', (req, res) => {
    putCount++;
    req.on('data', (chunk) => {
      putBytes += chunk;
    });
    req.on('end', () => res.status(200).end());
  });
  network.storagePort = ((await listen(storage).then((s) => s.address())) as AddressInfo).port;
  urls = [];
  for (const address of addresses) {
    const config = { address, service: 'mcp-peers.default.svc.cluster.local', port: 3002 };
    const registry = new SessionRegistry<StreamableHTTPServerTransport>({
      idleTtlMs: 60000,
      maxSessions: 20,
    });
    registries.push(registry);
    const app = express();
    app.use(
      '/mcp',
      (req, res, next) => {
        if (
          !['Bearer owner', 'Bearer refreshed', 'Bearer foreign'].includes(
            req.headers.authorization ?? '',
          )
        ) {
          res.status(401).end();
          return;
        }
        next();
      },
      createReplicaRouter('mcp', config, discover),
      express.json(),
    );
    app.all('/mcp', async (req, res) => {
      seen.push(address);
      const identity =
        req.headers.authorization === 'Bearer foreign' ? { ...owner, sub: 'foreign' } : owner;
      const id = req.headers['mcp-session-id'];
      let lease: ReturnType<typeof registry.acquire>;
      let transport: StreamableHTTPServerTransport;
      if (typeof id === 'string') {
        lease = registry.acquire(id, identity);
        if (!lease) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
        transport = lease.transport;
      } else {
        const reservation = registry.reserve()!;
        transport = new StreamableHTTPServerTransport({
          enableJsonResponse: true,
          sessionIdGenerator: () => createReplicaId(config),
          onsessioninitialized: (id) => {
            lease = reservation.commit(id, transport!, identity);
          },
        });
        const server = new McpServer({ name: 'replica-fixture', version: '1' });
        server.registerTool('echo', { inputSchema: {} }, async () => ({
          content: [{ type: 'text', text: address }],
        }));
        server.registerTool('paid-fixture', { inputSchema: {} }, async () => {
          paidCalls++;
          return { content: [{ type: 'text', text: 'ok' }] };
        });
        server.registerTool('hold', { inputSchema: {} }, async (_args, ctx) => {
          holdStarted();
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            ),
          );
          return { content: [{ type: 'text', text: 'cancelled' }] };
        });
        await server.connect(transport);
      }
      try {
        await transport.handleRequest(req, res, req.body);
      } finally {
        lease?.release();
      }
    });
    app.put(
      '/app-upload',
      createReplicaRouter('upload', config, discover),
      (_req, _res, next) => {
        uploadOwner = address;
        next();
      },
      appUploadHandler,
    );
    const server = await listen(app);
    const port = (server.address() as AddressInfo).port;
    network.ports.set(address, port);
    urls.push(`http://127.0.0.1:${port}`);
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(registries.splice(0).map((r) => r.closeAll()));
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections();
      return new Promise<void>((resolve) => s.close(() => resolve()));
    }),
  );
});
async function rpc(
  pod: number,
  id: string | undefined,
  body?: unknown,
  token = 'owner',
  method = 'POST',
  extra = {},
  signal?: AbortSignal,
) {
  return fetch(`${urls[pod]}/mcp`, {
    method,
    signal,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-03-26',
      ...(id ? { 'mcp-session-id': id } : {}),
      ...extra,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function initialize(pod = 0) {
  const res = await rpc(pod, undefined, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'openai-mcp', version: '1' },
    },
  });
  expect(res.status).toBe(200);
  await res.text();
  return res.headers.get('mcp-session-id')!;
}
it('preserves compressed MCP bodies when entering a different replica', async () => {
  const id = await initialize();
  for (const pod of [0, 3]) {
    const response = await fetch(`${urls[pod]}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer owner',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'mcp-session-id': id,
      },
      body: gzipSync(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'echo' })]) },
    });
  }
});
it('does not forward after the client disconnects during peer discovery', async () => {
  const id = await initialize();
  let release!: (addresses: string[]) => void;
  let started!: () => void;
  let closed!: () => void;
  const discovering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const discovery = new Promise<string[]>((resolve) => {
    release = resolve;
  });
  const app = express();
  app.use((_req, res, next) => {
    res.once('close', closed);
    next();
  });
  app.use(
    '/mcp',
    createReplicaRouter(
      'mcp',
      {
        address: addresses[4]!,
        service: 'mcp-peers.default.svc.cluster.local',
        port: 3002,
      },
      () => {
        started();
        return discovery;
      },
    ),
  );
  const port = ((await listen(app)).address() as AddressInfo).port;
  const controller = new AbortController();
  const result = fetch(`http://127.0.0.1:${port}/mcp`, {
    signal: controller.signal,
    headers: { 'mcp-session-id': id },
  }).catch((error) => error);
  await discovering;
  controller.abort();
  await disconnected;
  release([...addresses]);
  await result;
  await setImmediate();
  expect(network.targets).toEqual([]);
});
it('keeps initialize, notifications, tools, refreshed auth and DELETE on the owner across five replicas', async () => {
  const id = await initialize(2);
  expect((await rpc(0, id, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(
    202,
  );
  for (let i = 0; i < 15; i++) {
    const res = await rpc(
      i % 5,
      id,
      { jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: 'echo', arguments: {} } },
      i > 7 ? 'refreshed' : 'owner',
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as { result: { content: { text: string }[] } };
    expect(result.result.content[0]?.text).toBe(addresses[2]);
  }
  expect(new Set(seen)).toEqual(new Set([addresses[2]]));
  expect((await rpc(1, id, undefined, 'owner', 'DELETE')).status).toBe(200);
  expect((await rpc(4, id, { jsonrpc: '2.0', id: 20, method: 'tools/list' })).status).toBe(404);
});
it('preserves owner isolation and routes cancellation to the in-flight SDK request', async () => {
  const id = await initialize();
  await rpc(1, id, { jsonrpc: '2.0', method: 'notifications/initialized' });
  expect(
    (await rpc(4, id, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'foreign')).status,
  ).toBe(404);
  const stop = new AbortController();
  const pending = rpc(
    2,
    id,
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'hold', arguments: {} },
    },
    'owner',
    'POST',
    {},
    stop.signal,
  )
    .then((r) => r.text())
    .catch(() => undefined);
  await holdPromise;
  expect(
    (
      await rpc(
        3,
        id,
        {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 3, reason: 'user cancelled' },
        },
        'refreshed',
      )
    ).status,
  ).toBe(202);
  await vi.waitFor(() => expect(aborted).toBe(true));
  stop.abort();
  await pending;
});
it('routes a bounded single-use upload to its issuing pod and denies concurrent replay', async () => {
  vi.stubEnv('MCP_REPLICA_SERVICE', 'mcp-peers.default.svc.cluster.local');
  vi.stubEnv('PORTER_POD_IP', addresses[1]);
  const tool = relayUploadTool(
    {
      name: 'assets_create-upload-url',
      description: '',
      inputSchema: {},
      handler: async () => ({
        uploadUrl: 'https://storage.fixture.invalid/signed',
        url: 'https://storage.fixture.invalid/result',
        expiresIn: 300,
      }),
    },
    urls[1]!,
    'https://storage.fixture.invalid',
  );
  const grant = (await tool.handler({ contentType: 'video/mp4', size: 5 })) as {
    uploadUrl: string;
  };
  const ticket = new URL(grant.uploadUrl).search;
  const upload = (pod: number) =>
    fetch(`${urls[pod]}/app-upload${ticket}`, {
      method: 'PUT',
      headers: {
        'content-type': 'video/mp4',
        authorization: 'Bearer must-not-forward',
        'x-untrusted': 'must-not-forward',
      },
      body: 'hello',
    });
  const results = await Promise.all([upload(3), upload(4)]);
  expect(results.map((r) => r.status).sort()).toEqual([204, 403]);
  expect(uploadOwner).toBe(addresses[1]);
  expect(putBytes).toBe('hello');
  expect(putCount).toBe(1);
  for (const headers of network.headers) {
    expect(Array.isArray(headers)).toBe(false);
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).not.toHaveProperty('x-untrusted');
  }
});
it('fails closed for departed owners, discovery failures, foreign destinations and routing loops', async () => {
  const id = await initialize();
  peerState.addresses = addresses.slice(1);
  expect((await rpc(1, id, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status).toBe(404);
  peerState.addresses.push('169.254.169.254');
  const forged = createReplicaId({ address: '169.254.169.254', service: 'unused', port: 80 });
  expect((await rpc(2, forged, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status).toBe(404);
  peerState.fails = true;
  expect((await rpc(3, id, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status).toBe(503);
  expect(
    (
      await rpc(4, id, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'owner', 'POST', {
        'x-sync-replica-hop': '1',
      })
    ).status,
  ).toBe(503);
  expect(network.targets).toEqual([]);
});
it('does not replay a paid request after owner state is lost and supports a new session on a survivor', async () => {
  const id = await initialize();
  const call = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'paid-fixture', arguments: {} },
  };
  expect((await rpc(4, id, call)).status).toBe(200);
  await registries[0]!.closeAll();
  expect((await rpc(3, id, call)).status).toBe(404);
  expect(paidCalls).toBe(1);
  const replacement = await initialize(1);
  expect((await rpc(4, replacement, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status).toBe(
    200,
  );
});
it('keeps legacy IDs local and validates operator discovery configuration', async () => {
  expect((await rpc(1, randomUUID(), { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status).toBe(
    404,
  );
  expect(network.targets).toEqual([]);
  expect(getReplicaRoutingConfig({})).toBeUndefined();
  expect(() =>
    getReplicaRoutingConfig({ MCP_REPLICA_SERVICE: 'attacker.test', PORTER_POD_IP: '10.0.0.1' }),
  ).toThrow();
  expect(() =>
    getReplicaRoutingConfig({
      MCP_REPLICA_SERVICE: 'mcp-peers.default.svc.cluster.local',
      PORTER_POD_IP: '169.254.169.254',
    }),
  ).toThrow();
});

it('forwards SSE headers immediately and closes the routed stream when the client disconnects', async () => {
  const id = await initialize();
  await rpc(1, id, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const stop = new AbortController();
  const response = await rpc(4, id, undefined, 'owner', 'GET', {}, stop.signal);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  stop.abort();
  expect((await rpc(2, id, { jsonrpc: '2.0', id: 7, method: 'tools/list' })).status).toBe(200);
});

it('authenticates before forwarding', async () => {
  const id = await initialize();
  expect(
    (await rpc(3, id, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'invalid')).status,
  ).toBe(401);
  expect(network.targets).toEqual([]);
});
