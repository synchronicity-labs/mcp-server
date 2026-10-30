import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';
import { projectId, translationInput, translationSpec } from './test-fixtures/translation.js';

const importJobId = '00000000-0000-4000-8000-000000000004';
const generationId = '00000000-0000-4000-8000-000000000005';
const asset = { id: translationInput.videoAssetId, type: 'VIDEO', durationSeconds: 12 };
const spec = {
  ...translationSpec,
  paths: {
    ...translationSpec.paths,
    '/v2/assets': {
      post: {
        operationId: 'AssetsController_create',
        tags: ['Assets'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url', 'type'],
                properties: {
                  url: { type: 'string', format: 'uri' },
                  type: { type: 'string', enum: ['VIDEO', 'AUDIO', 'IMAGE'] },
                  projectId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
      },
    },
  },
};

type Reply = { status: number; body: unknown; retryAfter?: string };
const upstreams: Server[] = [];
const clients: Client[] = [];
const servers: McpServer[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const upstream of upstreams.splice(0)) {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

async function fixture(importReplies: Reply[]) {
  const calls: Array<{ path: string; body: unknown; token?: string; key?: string }> = [];
  const upstream = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') {
        res.end(JSON.stringify(spec));
        return;
      }
      let data = '';
      for await (const chunk of req) data += chunk.toString();
      calls.push({
        path: req.url!,
        body: data ? JSON.parse(data) : undefined,
        token: req.headers.authorization,
        key: req.headers['idempotency-key'] as string | undefined,
      });
      if (req.url === '/v2/assets') {
        const reply = importReplies.shift();
        res.statusCode = reply?.status ?? 500;
        if (reply?.retryAfter) res.setHeader('Retry-After', reply.retryAfter);
        res.end(JSON.stringify(reply?.body ?? { message: 'Unexpected import retry' }));
      } else if (req.url === `/v2/projects/${projectId}`) {
        res.end(JSON.stringify({ id: projectId }));
      } else if (req.url === '/v2/generate/estimate-cost') {
        res.end(JSON.stringify({ estimatedGenerationCost: 2 }));
      } else if (req.url === '/v2/generate') {
        res.end(JSON.stringify({ id: generationId, status: 'PENDING' }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    }),
  );
  upstreams.push(upstream);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
  const server = factory.createServer();
  servers.push(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  clients.push(client);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    runWithAuth('social-link-user', 'openai-mcp', () => client.callTool({ name, arguments: args }));
  return { client, calls, call };
}

it('imports a YouTube link to a saved asset before submitting Spanish translation through MCP', async () => {
  const stages = ['queued', 'downloading', 'processing'];
  const { client, calls, call } = await fixture([
    ...stages.map((importStatus, index) => ({
      status: 409,
      retryAfter: '15',
      body: {
        message: 'Video is still importing',
        errorCode: 'import_in_progress',
        importJobId,
        importStatus,
        progress: index * 30,
        privateField: 'must-not-leak',
      },
    })),
    { status: 201, body: asset },
  ]);
  const tools = (await client.listTools()).tools;
  const importTool = tools.find((tool) => tool.name === 'assets_create')!;
  expect(importTool.description).toContain('YouTube');
  expect(importTool.description).toContain('import_in_progress');
  expect(importTool._meta?.['openai/widgetAccessible']).toBe(true);
  const translate = tools.find((tool) => tool.name === 'create-translate-and-dub')!;
  expect(translate.description).toContain('assets_create');
  expect(client.getInstructions()).toContain('Translate this YouTube link to Spanish');
  expect(client.getInstructions()).toContain('do not submit a generation while importing');

  const args = { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', type: 'VIDEO', projectId };
  for (const [index, importStatus] of stages.entries()) {
    const result = await call('assets_create', args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        status: 409,
        code: 'import_in_progress',
        importJobId,
        importStatus,
        progress: index * 30,
        retryAfterMs: 15_000,
      },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(calls).toHaveLength(index + 1);
    expect(
      calls.every(
        (request) => request.path === '/v2/assets' && request.token === 'Bearer social-link-user',
      ),
    ).toBe(true);
  }
  const imported = await call('assets_create', args);
  expect(imported.isError).not.toBe(true);
  expect(imported.structuredContent).toEqual(asset);
  expect(calls.map((request) => request.body)).toEqual([args, args, args, args]);

  const saved = z
    .object({ id: z.uuid(), durationSeconds: z.number() })
    .parse(imported.structuredContent);
  await call('generate_estimate-cost', {
    model: translationInput.model,
    duration: saved.durationSeconds,
    workflow: 'translate-and-dub',
  });
  const result = await call('create-translate-and-dub', {
    ...translationInput,
    videoAssetId: saved.id,
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({ id: generationId, status: 'PENDING' });
  expect(calls.map((request) => request.path)).toEqual([
    ...Array.from({ length: 4 }, () => '/v2/assets'),
    '/v2/generate/estimate-cost',
    `/v2/projects/${projectId}`,
    '/v2/generate',
  ]);
  expect(calls.at(-1)).toMatchObject({
    token: 'Bearer social-link-user',
    key: translationInput.idempotencyKey,
    body: {
      projectId,
      input: [{ type: 'video', assetId: asset.id }],
      dubParams: { targetLang: 'es', sourceLang: 'auto' },
    },
  });
});

it.each([
  { status: 403, code: 'import_not_enabled' },
  { status: 422, code: 'import_failed' },
  { status: 429, code: 'import_daily_limit_reached' },
  { status: 429, code: 'concurrency_limit_reached' },
  { status: 503, code: 'import_unavailable' },
])('surfaces $code without retrying or submitting translation', async ({ status, code }) => {
  const { call, calls } = await fixture([
    {
      status,
      body: {
        message: 'Import cannot proceed',
        errorCode: code,
        ...(code === 'import_failed' ? { importJobId } : {}),
      },
    },
  ]);
  const result = await call('assets_create', {
    url: 'https://youtu.be/dQw4w9WgXcQ',
    type: 'VIDEO',
    projectId,
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { status, code, ...(code === 'import_failed' ? { importJobId } : {}) },
  });
  expect(calls.map((request) => request.path)).toEqual(['/v2/assets']);
});

it('still registers a direct media URL without import polling', async () => {
  const { call, calls } = await fixture([{ status: 201, body: asset }]);
  const result = await call('assets_create', {
    url: 'https://example.com/video.mp4',
    type: 'VIDEO',
    projectId,
  });
  expect(result.structuredContent).toEqual(asset);
  expect(result.isError).not.toBe(true);
  expect(calls).toHaveLength(1);
});
