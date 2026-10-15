import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const audioAssetId = '00000000-0000-4000-8000-000000000002';
const jobId = '00000000-0000-4000-8000-000000000003';
const idempotencyKey = '00000000-0000-4000-8000-000000000004';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture({
  available = true,
  rejection,
  transport = 'http',
  preview = { sourceDurationSeconds: 120, quotedDurationSeconds: 120, limitSeconds: null },
}: {
  available?: boolean;
  rejection?: { status: number; message: string; errorCode?: string };
  transport?: 'http' | 'stdio';
  preview?: {
    sourceDurationSeconds: number;
    quotedDurationSeconds: number;
    limitSeconds: number | null;
  } | null;
} = {}) {
  const calls: { path: string; key?: string; token?: string; body?: unknown }[] = [];
  let readStatus = 'COMPLETED';
  const upstream = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api-json') {
      res.end(
        JSON.stringify({
          openapi: '3.0.0',
          paths: available
            ? {
                '/v2/dubbing/jobs': {
                  post: {
                    operationId: 'DubbingJobs_createJob',
                    tags: ['Dubbing'],
                    requestBody: {
                      content: {
                        'application/json': {
                          schema: {
                            type: 'object',
                            properties: { targetLang: { type: 'string', enum: ['es', 'fr'] } },
                          },
                        },
                      },
                    },
                  },
                },
                '/v2/dubbing/jobs/estimate': {
                  post: { operationId: 'DubbingJobs_estimate', tags: ['Dubbing'] },
                },
                '/v2/dubbing/jobs/{id}': {
                  get: {
                    operationId: 'DubbingJobs_getJob',
                    tags: ['Dubbing'],
                    parameters: [
                      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                    ],
                  },
                },
              }
            : {},
        }),
      );
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    calls.push({
      path: req.url!,
      key: req.headers['idempotency-key'] as string | undefined,
      token: req.headers.authorization,
      body: raw ? JSON.parse(raw) : undefined,
    });
    if (rejection) {
      res.statusCode = rejection.status;
      res.end(JSON.stringify(rejection));
      return;
    }
    if (req.url === '/v2/dubbing/jobs/estimate')
      res.end(
        JSON.stringify({
          billing: preview?.limitSeconds == null ? 'external' : 'included',
          estimatedCredits: null,
          estimatedGenerationCost: preview?.limitSeconds == null ? null : 0,
          ...(preview ? { preview } : {}),
          privateIntegrationKey: 'must-not-leak',
        }),
      );
    else
      res.end(
        JSON.stringify({
          id: jobId,
          projectId,
          status: req.method === 'GET' ? readStatus : 'PROCESSING',
          sourceLang: 'auto',
          targetLang: 'es',
          outputMediaUrl: req.method === 'GET' ? 'https://media.example.test/translated.wav' : null,
          outputDurationSec: req.method === 'GET' ? 2 : null,
          error: null,
          createdAt: '2026-10-15T12:00:00.000Z',
          recoveryRequired: false,
          privateProviderId: 'must-not-leak',
        }),
      );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  cleanups.push(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport,
    port: 0,
  });
  const server = factory.createServer();
  cleanups.push(() => server.close());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  cleanups.push(() => client.close());
  await client.connect(ct);
  const call = (name: string, args: Record<string, unknown>) =>
    runWithAuth('translation-user', 'openai-mcp', () => client.callTool({ name, arguments: args }));
  return {
    client,
    call,
    calls,
    setReadStatus: (status: string) => {
      readStatus = status;
    },
  };
}

it.each([
  'http',
  'stdio',
] as const)('%s quotes and admits only a keyed standalone dub, then reads its translated audio', async (transport) => {
  const { client, call, calls, setReadStatus } = await fixture({ transport });
  const catalog = (await client.listTools()).tools;
  expect(catalog.filter((tool) => tool.name.startsWith('dubbing-jobs_'))).toEqual([]);
  const tool = catalog.find((t) => t.name === 'create-translation-preview');
  expect(tool?._meta?.['openai/widgetAccessible']).toBe(true);
  const quote = await call('estimate-translation-preview', { projectId, audioAssetId });
  expect(quote.structuredContent).toMatchObject({
    billing: 'external',
    preview: { sourceDurationSeconds: 120, quotedDurationSeconds: 120, limitSeconds: null },
  });
  expect(JSON.stringify(quote)).not.toContain('must-not-leak');
  expect(
    (
      await call('create-translation-preview', {
        projectId,
        audioAssetId,
        targetLang: 'es',
        idempotencyKey,
      })
    ).structuredContent,
  ).toMatchObject({ id: jobId, status: 'PROCESSING' });
  setReadStatus('COMPLETING');
  const completing = await call('get-translation-preview', { projectId, id: jobId });
  expect(completing.structuredContent).toMatchObject({
    id: jobId,
    status: 'COMPLETING',
    createdAt: '2026-10-15T12:00:00.000Z',
  });
  setReadStatus('COMPLETED');
  const completed = await call('get-translation-preview', { projectId, id: jobId });
  expect(completed.structuredContent).toMatchObject({
    status: 'COMPLETED',
    outputMediaUrl: 'https://media.example.test/translated.wav',
  });
  expect(JSON.stringify(completed)).not.toContain('must-not-leak');
  expect(calls).toEqual([
    {
      path: '/v2/dubbing/jobs/estimate',
      key: undefined,
      token: 'Bearer translation-user',
      body: { projectId, audioAssetId },
    },
    {
      path: '/v2/dubbing/jobs',
      key: idempotencyKey,
      token: 'Bearer translation-user',
      body: { projectId, audioAssetId, targetLang: 'es', sourceLang: 'auto' },
    },
    {
      path: `/v2/dubbing/jobs/${jobId}?projectId=${projectId}`,
      key: undefined,
      token: 'Bearer translation-user',
      body: undefined,
    },
    {
      path: `/v2/dubbing/jobs/${jobId}?projectId=${projectId}`,
      key: undefined,
      token: 'Bearer translation-user',
      body: undefined,
    },
  ]);
});
it('preserves the server preview cap and accepts an older uncapped quote without starting work', async () => {
  const limited = await fixture({
    preview: { sourceDurationSeconds: 120, quotedDurationSeconds: 20, limitSeconds: 20 },
  });
  await limited.client.listTools();
  expect(
    (await limited.call('estimate-translation-preview', { projectId, audioAssetId }))
      .structuredContent,
  ).toMatchObject({
    billing: 'included',
    preview: { sourceDurationSeconds: 120, quotedDurationSeconds: 20, limitSeconds: 20 },
  });
  expect(limited.calls.map((request) => request.path)).toEqual(['/v2/dubbing/jobs/estimate']);
  const legacy = await fixture({ preview: null });
  await legacy.client.listTools();
  expect(
    (await legacy.call('estimate-translation-preview', { projectId, audioAssetId }))
      .structuredContent,
  ).toEqual({
    billing: 'external',
    estimatedGenerationCost: null,
    estimatedCredits: null,
  });
  expect(legacy.calls.map((request) => request.path)).toEqual(['/v2/dubbing/jobs/estimate']);
});
it.each([
  undefined,
  'invalid-key',
])('rejects admission key %s before any upstream request', async (key) => {
  const { call, calls } = await fixture();
  expect(
    (
      await call('create-translation-preview', {
        projectId,
        audioAssetId,
        targetLang: 'es',
        ...(key ? { idempotencyKey: key } : {}),
      })
    ).isError,
  ).toBe(true);
  expect(calls).toHaveLength(0);
});
it.each([
  { status: 422, message: 'Project not found' },
  { status: 402, message: 'No free previews remain', errorCode: 'free_tier_generations_exhausted' },
  { status: 402, message: 'Account payment hold', errorCode: 'account_payment_required' },
  { status: 402, message: 'Not enough credits', errorCode: 'insufficient_credits' },
])('preserves typed rejection $errorCode without retrying paid admission', async (rejection) => {
  const { client, call, calls } = await fixture({ rejection });
  await client.listTools();
  for (const [name, args] of [
    ['estimate-translation-preview', { projectId, audioAssetId }],
    ['create-translation-preview', { projectId, audioAssetId, targetLang: 'es', idempotencyKey }],
  ] as const) {
    const rejected = await call(name, args);
    expect(rejected.isError).toBe(true);
    const text = (rejected.content as { type: string; text?: string }[]).find(
      (part) => part.type === 'text',
    )?.text;
    const payload = JSON.parse(text!);
    expect(payload.error).toMatchObject({
      status: rejection.status,
      ...(rejection.errorCode ? { code: rejection.errorCode } : {}),
    });
    expect(payload.error.message).toContain(rejection.message);
  }
  expect(calls.map((request) => request.path)).toEqual([
    '/v2/dubbing/jobs/estimate',
    '/v2/dubbing/jobs',
  ]);
});
it('omits standalone translation tools against an older API', async () => {
  const { client, calls } = await fixture({ available: false });
  expect(
    (await client.listTools()).tools.some((t) => t.name === 'create-translation-preview'),
  ).toBe(false);
  expect(calls).toHaveLength(0);
});
