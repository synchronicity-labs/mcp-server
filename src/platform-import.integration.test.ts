import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';

const projectId = '00000000-0000-4000-8000-000000000003';
const jobId = '00000000-0000-4000-8000-000000000004';
const assetId = '00000000-0000-4000-8000-000000000005';
const url = 'https://www.youtube.com/watch?v=fixture';
const dispose: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close();
});

async function fixture({ account = true, complete = true } = {}) {
  const calls: Array<{ path: string; method?: string; body?: unknown; auth?: string }> = [];
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const parsed = new URL(req.url!, 'http://fixture');
    if (parsed.pathname === '/api-json') {
      const paths = Object.fromEntries(
        [
          ['detect', 'get'],
          ['metadata', 'get'],
          ['start', 'post'],
          ['status', 'get'],
          ['', 'get'],
          ['cancel', 'post'],
          ...(complete ? [['retry', 'post']] : []),
        ].map(([name, method]) => [
          `/v2/platform-import${name ? `/${name}` : ''}`,
          {
            [method!]: {
              operationId: `PlatformImportController_${name || 'list'}`,
              tags: ['Platform Import'],
            },
          },
        ]),
      );
      res.end(JSON.stringify({ openapi: '3.0.0', paths }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    calls.push({
      path: req.url!,
      method: req.method,
      body: raw ? JSON.parse(raw) : undefined,
      auth: req.headers.authorization,
    });
    if (parsed.pathname === '/v2/oauth/account')
      res.end(JSON.stringify({ account: account ? { id: assetId } : null }));
    else if (parsed.pathname.endsWith('/detect'))
      res.end(JSON.stringify({ platform: 'youtube', supported: true, normalizedUrl: url }));
    else if (parsed.pathname.endsWith('/metadata'))
      res.end(
        JSON.stringify({
          title: 'Video',
          author: 'Creator',
          durationSeconds: 10,
          thumbnailUrl: null,
          platform: 'youtube',
          fileSizeBytes: 100,
          availableQualities: ['1080'],
          rawMetadata: { private: 'omit' },
        }),
      );
    else if (parsed.pathname.endsWith('/start'))
      res.end(JSON.stringify({ jobId, status: 'queued' }));
    else if (parsed.pathname.endsWith('/status'))
      res.end(
        JSON.stringify({
          jobId,
          assetId,
          status: 'completed',
          platform: 'youtube',
          progress: 100,
          startedAt: '2026-10-26T00:00:00Z',
          updatedAt: '2026-10-26T00:00:00Z',
        }),
      );
    else if (parsed.pathname.endsWith('/cancel')) res.end(JSON.stringify({ success: true }));
    else if (parsed.pathname.endsWith('/retry'))
      res.end(JSON.stringify({ success: true, newJobId: jobId }));
    else if (parsed.pathname === '/v2/platform-import')
      res.end(JSON.stringify({ jobs: [], total: 0 }));
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  dispose.push(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'http',
    port: 0,
  });
  const server = factory.createServer();
  dispose.push(() => server.close());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'openai-mcp', version: '1' });
  await client.connect(ct);
  dispose.push(() => client.close());
  return {
    client,
    calls,
    call: (name: string, args: Record<string, unknown> = {}) =>
      runWithAuth('platform-account', 'openai-mcp', () =>
        client.callTool({ name, arguments: args }),
      ),
  };
}

it('starts once with the canonical body then reads the same completed job without starting another import', async () => {
  const { client, calls, call } = await fixture();
  const started = await call('start-platform-import', {
    url,
    projectId,
    organizationId: 'foreign',
    userId: 'foreign',
  });
  expect(started, JSON.stringify(started)).not.toHaveProperty('isError', true);
  expect(started.structuredContent).toEqual({ jobId, status: 'queued' });
  const status = await call('get-platform-import', { jobId });
  expect(status.structuredContent).toMatchObject({ jobId, assetId, status: 'completed' });
  expect(calls.filter((c) => c.method === 'POST')).toEqual([
    {
      path: '/v2/platform-import/start',
      method: 'POST',
      body: { url, projectId },
      auth: 'Bearer platform-account',
    },
  ]);
  const tools = (await client.listTools()).tools;
  expect(tools.find((t) => t.name === 'cancel-platform-import')?.annotations?.destructiveHint).toBe(
    true,
  );
  expect(tools.find((t) => t.name === 'get-platform-import')?.annotations?.readOnlyHint).toBe(true);
  expect(
    tools.find((t) => t.name === 'start-platform-import')?._meta?.['openai/widgetAccessible'],
  ).toBe(true);
});

it('projects metadata without raw provider data and forwards explicit cancel/retry only', async () => {
  const { calls, call } = await fixture();
  const metadata = await call('get-platform-link-metadata', { url });
  expect(metadata, JSON.stringify(metadata)).not.toHaveProperty('isError', true);
  expect(metadata.structuredContent).not.toHaveProperty('rawMetadata');
  expect((await call('cancel-platform-import', { jobId })).structuredContent).toEqual({
    success: true,
  });
  expect((await call('retry-platform-import', { jobId })).structuredContent).toEqual({
    success: true,
    newJobId: jobId,
  });
  expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
    { jobId },
    { jobId },
  ]);
});

it('refuses API-key-only accounts before any platform operation', async () => {
  const { calls, call } = await fixture({ account: false });
  expect((await call('start-platform-import', { url, projectId })).isError).toBe(true);
  expect(calls.map((c) => ({ path: c.path, method: c.method }))).toEqual([
    { path: '/v2/oauth/account', method: 'GET' },
  ]);
});

it('does not advertise the capability with an incomplete API rollout', async () => {
  const { client } = await fixture({ complete: false });
  expect((await client.listTools()).tools.some((t) => t.name === 'start-platform-import')).toBe(
    false,
  );
});
