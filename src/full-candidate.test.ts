import { type EventEmitter, once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import express from 'express';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startHttpServer } from './http-server.js';
import { createMcpServerFactory } from './server.js';

// Exercise the production factory AND hosted auth/session wiring together.
// All credentials, media IDs and API responses are local test fixtures.
let upstream: Server | undefined;
let hosted: Server | undefined;
let url: string;
const clients: Client[] = [];
const events = ['SIGINT', 'SIGTERM', 'uncaughtExceptionMonitor', 'warning', 'exit'] as const;
const emitter: EventEmitter = process;
const previous = new Map<string, ReturnType<EventEmitter['listeners']>>();
const calls: Array<{ path: string; token?: string; body: Record<string, unknown> }> = [];
const signedUrl = 'https://fixture.invalid/result.mp4?Signature=a%2Fb%2Bc&Expires=123';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const projectStarted = deferred<void>();
const projectAborted = deferred<void>();
const projectRelease = deferred<void>();
const spec = {
  openapi: '3.0.0',
  paths: {
    '/v2/voices': { get: { operationId: 'Voices_getVoices', tags: ['voices'] } },
    '/v2/generate/{id}': {
      get: {
        operationId: 'Generate_getGeneration',
        tags: ['generate'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'wait', in: 'query', schema: { type: 'boolean' } },
          { name: 'timeout', in: 'query', schema: { type: 'number' } },
        ],
      },
    },
  },
};

beforeAll(async () => {
  for (const event of events) previous.set(event, emitter.listeners(event));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  upstream = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const token = req.headers.authorization;
    calls.push({ path, token, body });
    res.setHeader('Content-Type', 'application/json');
    if (path === '/api-json') {
      res.end(JSON.stringify(spec));
      return;
    }
    if (path === '/v2/oauth/userinfo') {
      const status =
        token === 'Bearer rate-limited'
          ? 429
          : token === 'Bearer unavailable'
            ? 503
            : token === 'Bearer invalid'
              ? 401
              : 200;
      res.statusCode = status;
      res.setHeader('Retry-After', '9');
      res.end(
        JSON.stringify({
          sub: 'fixture-user',
          client_id: 'verified-oauth-client',
          expires_at: 4000000000,
        }),
      );
      return;
    }
    if (path === '/v2/projects') {
      if (token === 'Bearer cancelled' && req.method === 'GET') {
        res.on('close', () => {
          if (!res.writableEnded) projectAborted.resolve();
        });
        projectStarted.resolve();
        await projectRelease.promise;
      }
      res.end(
        JSON.stringify(req.method === 'GET' ? { items: [] } : { id: `project:${body.name}` }),
      );
      return;
    }
    if (path === '/v2/voices') {
      res.end(JSON.stringify({ voices: [{ id: 'fixture-voice' }] }));
      return;
    }
    if (path === '/v2/generate') {
      res.end(JSON.stringify({ id: 'generation', status: 'PENDING' }));
      return;
    }
    if (path === '/v2/generate/generation') {
      res.end(JSON.stringify({ id: 'generation', status: 'COMPLETED', outputUrl: signedUrl }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
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
  await startHttpServer(await createMcpServerFactory(config), config);
  if (!hosted) throw new Error('Hosted fixture did not start');
  url = `http://127.0.0.1:${(hosted.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => {
  projectRelease.resolve();
  try {
    await Promise.allSettled(clients.map((client) => client.close()));
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
  }
});
async function connect(name: string, token = name) {
  const client = new Client({ name, version: 'fixture' });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
it('preserves profiles, authenticated writes and signed results across concurrent hosted sessions', async () => {
  await Promise.all(
    ['chatgpt', 'claude', 'unknown'].map(async (name, index) => {
      const client = await connect(name);
      const tools = (await client.listTools()).tools;
      expect(tools.length).toBe(index === 0 ? 5 : 3);
      const create = tools.find((tool) => tool.name === 'create-lipsync')!;
      expect(Boolean(create._meta?.['openai/fileParams'])).toBe(index === 0);
      expect((await client.listResources()).resources.length > 0).toBe(index === 0);
      expect(
        JSON.stringify(await client.callTool({ name: 'voices_get-voices', arguments: {} })),
      ).toContain('fixture-voice');
      expect(
        (
          await client.callTool({
            name: 'create-lipsync',
            arguments: { imageAssetId: 'fixture-image', script: 'Hello', voiceId: 'fixture-voice' },
          })
        ).isError,
      ).not.toBe(true);
      const posted = calls.find(
        (call) => call.path === '/v2/generate' && call.token === `Bearer ${name}`,
      );
      expect(posted?.body.projectId).toBe(
        `project:${['ChatGPT generations', 'Claude generations', 'Sync generations'][index]}`,
      );
      const result = await client.callTool({
        name: 'generate_get-generation',
        arguments: { id: 'generation', wait: true, timeout: 55 },
      });
      expect(result.structuredContent).toMatchObject({ outputUrl: signedUrl });
    }),
  );
});
it.each([
  ['rate-limited', 429],
  ['unavailable', 503],
  ['invalid', 401],
] as const)('preserves %s auth semantics on the full server', async (token, status) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(status);
  if (status !== 401) {
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(response.headers.get('retry-after')).toBe('9');
    expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
  } else {
    expect(response.headers.get('www-authenticate')).toContain('invalid_token');
    await response.text();
  }
});
it('rejects an unsupported Origin before verification or tool execution', async () => {
  const before = calls.length;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Origin: 'https://unverified-meta.invalid',
      Authorization: 'Bearer unknown',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  expect(response.status).toBe(403);
  await response.text();
  expect(calls.length).toBe(before);
});
it('propagates explicit cancellation through bearer auth, sessions and the profile wrapper', async () => {
  const client = await connect('unknown', 'cancelled');
  const cancel = new AbortController();
  const pending = client.callTool(
    {
      name: 'create-lipsync',
      arguments: { videoAssetId: 'fixture-video', audioAssetId: 'fixture-audio' },
    },
    undefined,
    { signal: cancel.signal },
  );
  const rejected = expect(pending).rejects.toThrow();
  await projectStarted.promise;
  cancel.abort(new Error('explicit cancel'));
  await rejected;
  await projectAborted.promise;
  projectRelease.resolve();
  expect(
    calls.filter((call) => call.token === 'Bearer cancelled' && call.path === '/v2/generate'),
  ).toHaveLength(0);
  expect(
    calls.filter((call) => call.token === 'Bearer cancelled' && call.path === '/v2/projects'),
  ).toHaveLength(1);
});
