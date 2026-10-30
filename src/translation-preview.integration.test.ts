import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const audioAssetId = '00000000-0000-4000-8000-000000000002';
const jobId = '00000000-0000-4000-8000-000000000003';
const idempotencyKey = '00000000-0000-4000-8000-000000000004';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  for (let cleanup = pending.pop(); cleanup; cleanup = pending.pop()) await cleanup();
});
async function fixture({
  available = true,
  rejection,
  legacy = false,
  incomplete,
  transport = 'http',
  preview = { sourceDurationSeconds: 120, quotedDurationSeconds: 120, limitSeconds: null },
}: {
  available?: boolean;
  legacy?: boolean;
  incomplete?: 'header' | 'project' | 'version' | 'source';
  rejection?: {
    status: number;
    message: string;
    errorCode?: string;
    generationId?: string;
    retryAfterSeconds?: number;
  };
  transport?: 'http' | 'stdio';
  preview?: {
    sourceDurationSeconds: number;
    quotedDurationSeconds: number;
    limitSeconds: number | null;
  } | null;
} = {}) {
  const calls: { path: string; key?: string; token?: string; body?: unknown }[] = [];
  let readStatus = 'COMPLETED';
  const upstream = createServer(asyncRequestListener(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api-json') {
      res.end(
        JSON.stringify({
          openapi: '3.0.0',
          paths: available
            ? {
                '/v2/integrations/dubbing': {
                  post: {
                    operationId: 'DubbingController_createDubbing',
                    tags: ['Dubbing'],
                    ...(!legacy ? { 'x-sync-saved-asset-dubbing': 1 } : {}),
                    parameters:
                      incomplete === 'header'
                        ? []
                        : [
                            {
                              name: 'Idempotency-Key',
                              in: 'header',
                              required: false,
                              schema: { type: 'string' },
                            },
                          ],
                    requestBody: {
                      content: {
                        'application/json': {
                          schema: {
                            type: 'object',
                            properties: {
                              targetLang: { type: 'string', enum: ['es', 'fr'] },
                              ...(!legacy
                                ? {
                                    audioAssetId: {
                                      type: 'string',
                                      format: incomplete === 'source' ? 'uri' : 'uuid',
                                    },
                                    projectId: { type: 'string', format: 'uuid' },
                                  }
                                : {}),
                            },
                          },
                        },
                      },
                    },
                  },
                },
                '/v2/integrations/dubbing/estimate': {
                  post: {
                    operationId: 'DubbingController_estimateDubbingCost',
                    tags: ['Dubbing'],
                    ...(!legacy
                      ? { 'x-sync-saved-asset-dubbing': incomplete === 'version' ? 2 : 1 }
                      : {}),
                    requestBody: {
                      content: {
                        'application/json': {
                          schema: {
                            type: 'object',
                            properties: {
                              audioAssetId: {
                                type: 'string',
                                format: incomplete === 'source' ? 'uri' : 'uuid',
                              },
                              projectId: { type: 'string', format: 'uuid' },
                              preview: { type: 'boolean' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
                '/v2/integrations/dubbing/{id}': {
                  get: {
                    operationId: 'DubbingController_getDubbingGeneration',
                    tags: ['Dubbing'],
                    ...(!legacy ? { 'x-sync-saved-asset-dubbing': 1 } : {}),
                    parameters: [
                      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                      ...(incomplete === 'project'
                        ? []
                        : [
                            {
                              name: 'projectId',
                              in: 'query',
                              required: false,
                              schema: { type: 'string', format: 'uuid' },
                            },
                          ]),
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
      if (rejection.retryAfterSeconds) res.setHeader('retry-after', rejection.retryAfterSeconds);
      res.end(JSON.stringify(rejection));
      return;
    }
    if (req.url === '/v2/integrations/dubbing/estimate')
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
  }));
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

it.each(['http', 'stdio'] as const)(
  '%s quotes and admits only a keyed standalone dub, then reads its translated audio',
  async (transport) => {
    const { client, call, calls, setReadStatus } = await fixture({ transport });
    const catalog = (await client.listTools()).tools;
    expect(catalog.filter((tool) => tool.name.startsWith('dubbing_'))).toEqual([]);
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
        path: '/v2/integrations/dubbing/estimate',
        key: undefined,
        token: 'Bearer translation-user',
        body: { projectId, audioAssetId, preview: true },
      },
      {
        path: '/v2/integrations/dubbing',
        key: idempotencyKey,
        token: 'Bearer translation-user',
        body: { projectId, audioAssetId, targetLang: 'es', sourceLang: 'auto' },
      },
      {
        path: `/v2/integrations/dubbing/${jobId}?projectId=${projectId}`,
        key: undefined,
        token: 'Bearer translation-user',
        body: undefined,
      },
      {
        path: `/v2/integrations/dubbing/${jobId}?projectId=${projectId}`,
        key: undefined,
        token: 'Bearer translation-user',
        body: undefined,
      },
    ]);
  },
);
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
  expect(limited.calls.map((request) => request.path)).toEqual([
    '/v2/integrations/dubbing/estimate',
  ]);
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
  expect(legacy.calls.map((request) => request.path)).toEqual([
    '/v2/integrations/dubbing/estimate',
  ]);
});
it.each([undefined, 'invalid-key'])(
  'rejects admission key %s before any upstream request',
  async (key) => {
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
  },
);
it.each([
  { status: 422, message: 'Project not found' },
  { status: 403, message: 'Project access revoked' },
  {
    status: 429,
    message: 'Recover the existing job',
    errorCode: 'rate_limited',
    retryAfterSeconds: 2,
    generationId: jobId,
  },
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
    // Retained packaged widgets decode errors only from this protocol field.
    expect(rejected.structuredContent).toEqual(payload);
    if ('retryAfterSeconds' in rejection) expect(payload.error.retryAfterMs).toBe(2000);
    if ('generationId' in rejection) expect(payload.error.generationId).toBe(jobId);
    expect(payload.error).toMatchObject({
      status: rejection.status,
      ...(rejection.errorCode ? { code: rejection.errorCode } : {}),
    });
    expect(payload.error.message).toContain(rejection.message);
  }
  expect(calls.map((request) => request.path)).toEqual([
    '/v2/integrations/dubbing/estimate',
    '/v2/integrations/dubbing',
  ]);
});
it.each([
  { available: false },
  { legacy: true },
  { incomplete: 'header' },
  { incomplete: 'project' },
  { incomplete: 'version' },
  { incomplete: 'source' },
] as const)('omits standalone translation tools against an older API %j', async (options) => {
  const { client, calls } = await fixture({ ...options, transport: 'stdio' });
  const catalog = (await client.listTools()).tools;
  expect(catalog.some((t) => t.name === 'create-translation-preview')).toBe(false);
  expect(catalog.filter((t) => t.name.startsWith('dubbing_'))).toEqual([]);
  expect(calls).toHaveLength(0);
});
