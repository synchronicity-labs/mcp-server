import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyncMcpServer } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

// scenes_detect and stems_separate calls over stdio with an API key, against a stub API.
// Calls are not gated on account features (the API decides); listing is, in
// account-features.integration.test.ts.
const VIDEO = '51ef4ef2-84af-4622-b0d0-c47ac04785da';
const STEMS_JOB = '7d4b8f0e-2c1a-4e3b-9f6d-5a8c7b9e0d1f';
const VOCALS = '0b6f7c1e-3d2a-4f5b-8e9c-1a2b3c4d5e6f';
const BACKGROUND = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';

type Route = (method: string, url: string) => { status?: number; body: unknown } | undefined;
type Call = { method: string; url: string; body: unknown };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

async function stubApi(route: Route) {
  const calls: Call[] = [];
  const upstream = createServer(
    asyncRequestListener(async (req, res: ServerResponse) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json')
        return void res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
      let raw = '';
      for await (const chunk of req) raw += chunk.toString();
      // Only the routes under test; stdio startup makes its own background requests.
      if (req.url!.startsWith('/v2/asset'))
        calls.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : undefined });
      const answer = route(req.method!, req.url!) ?? {
        status: 500,
        body: { message: `unexpected ${req.method} ${req.url}` },
      };
      res.statusCode = answer.status ?? 200;
      res.end(JSON.stringify(answer.body));
    }),
  );
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  cleanups.push(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  return { calls, baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` };
}

async function setup(route: Route) {
  const { calls, baseUrl } = await stubApi(route);
  const server = await createSyncMcpServer({
    apiKey: 'test-key',
    baseUrl,
    transport: 'stdio',
    port: 0,
  });
  cleanups.push(() => server.close());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  cleanups.push(() => client.close());
  await client.connect(ct);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  return { client, call, calls };
}

const SCENES = `/v2/asset-metadata/scenes?assetId=${VIDEO}`;
const STEMS = `/v2/assets/${VIDEO}/separate-stems`;
// Nest's bare NotFoundException, which a disabled feature flag throws.
const FLAG_OFF = { status: 404, body: { message: 'Not Found', statusCode: 404 } };
const completedScenes = {
  status: 'completed',
  fps: 25,
  scenes: [
    { startFrame: 0, endFrame: 49, startSeconds: 0, endSeconds: 2 },
    { startFrame: 50, endFrame: 99, startSeconds: 2, endSeconds: 4 },
  ],
};
const stemsJob = (status: string, extra: Record<string, unknown> = {}) => ({
  id: STEMS_JOB,
  assetId: VIDEO,
  status,
  vocalsAssetId: null,
  backgroundAssetId: null,
  vocalsUrl: null,
  backgroundUrl: null,
  error: null,
  createdAt: '2026-11-05T10:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
  ...extra,
});
const completedStems = stemsJob('completed', {
  vocalsAssetId: VOCALS,
  backgroundAssetId: BACKGROUND,
  vocalsUrl: 'https://storage.sync.so/org/vocals.wav',
  backgroundUrl: 'https://storage.sync.so/org/background.wav',
});

describe('asset analysis tools', () => {
  it('starts scene detection and waits until the scenes are stored', async () => {
    let started = false;
    let polls = 0;
    const { call, calls } = await setup((method, url) => {
      if (method === 'POST' && url === '/v2/asset-metadata/scene-detection') {
        started = true;
        return { status: 202, body: { success: true, jobId: `${VIDEO}_scene_1` } };
      }
      if (method === 'GET' && url === SCENES) {
        if (!started) return { body: { status: 'not_requested', fps: 25, scenes: [] } };
        polls += 1;
        return { body: polls > 1 ? completedScenes : { status: 'pending', fps: 25, scenes: [] } };
      }
    });
    const result = await call('scenes_detect', { assetId: VIDEO, wait: true });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      assetId: VIDEO,
      jobId: `${VIDEO}_scene_1`,
      ...completedScenes,
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${SCENES}`,
      'POST /v2/asset-metadata/scene-detection',
      `GET ${SCENES}`,
      `GET ${SCENES}`,
    ]);
    expect(calls[1]?.body).toEqual({ assetId: VIDEO });
  });

  it('returns stored scenes without starting detection again', async () => {
    const { call, calls } = await setup((method, url) =>
      method === 'GET' && url === SCENES ? { body: completedScenes } : undefined,
    );
    const result = await call('scenes_detect', { assetId: VIDEO });
    expect(result.structuredContent).toEqual({ assetId: VIDEO, ...completedScenes });
    expect(calls).toHaveLength(1);
  });

  it('starts without waiting, and names a non-video asset', async () => {
    let skipped = false;
    const { call } = await setup((method, url) => {
      if (method === 'GET') return { body: { status: 'failed', fps: null, scenes: [] } };
      if (url === '/v2/asset-metadata/scene-detection')
        return skipped
          ? {
              status: 202,
              body: { success: false, skipped: true, reason: 'unsupported_asset_type' },
            }
          : { status: 202, body: { success: true, jobId: 'job-2' } };
    });
    const pending = await call('scenes_detect', { assetId: VIDEO });
    expect(pending.structuredContent).toEqual({
      assetId: VIDEO,
      status: 'pending',
      fps: null,
      scenes: [],
      jobId: 'job-2',
    });
    skipped = true;
    const audio = await call('scenes_detect', { assetId: VIDEO });
    expect(audio.isError).toBe(true);
    expect(JSON.stringify(audio.content)).toContain('Scene detection needs a VIDEO asset');
  });

  it('separates stems and waits until both assets exist', async () => {
    let started = false;
    let polls = 0;
    const { call, calls } = await setup((method, url) => {
      if (url !== STEMS) return undefined;
      if (method === 'POST') {
        started = true;
        return { status: 202, body: stemsJob('pending') };
      }
      if (!started)
        return {
          status: 404,
          body: { statusCode: 404, errorCode: 'stem_separation_not_found', message: 'none' },
        };
      polls += 1;
      return { body: polls > 1 ? completedStems : stemsJob('processing') };
    });
    const result = await call('stems_separate', { assetId: VIDEO, wait: true });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(completedStems);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET', 'GET']);
    expect(calls[1]?.body).toBeUndefined();
  });

  it('returns a running or completed separation without starting another, and retries a failed one', async () => {
    let current: unknown = completedStems;
    const { call, calls } = await setup((method, url) => {
      if (url !== STEMS) return undefined;
      if (method === 'POST') return { status: 202, body: stemsJob('pending') };
      return { body: current };
    });
    expect((await call('stems_separate', { assetId: VIDEO })).structuredContent).toEqual(
      completedStems,
    );
    current = stemsJob('failed', {
      error: { code: 'stem_separation_failed', message: 'The provider failed.' },
    });
    expect((await call('stems_separate', { assetId: VIDEO })).structuredContent).toMatchObject({
      status: 'pending',
    });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST']);
  });

  it('explains a source outside Sync storage', async () => {
    const { call } = await setup((method, url) => {
      if (url !== STEMS) return undefined;
      if (method === 'GET')
        return {
          status: 404,
          body: { statusCode: 404, errorCode: 'stem_separation_not_found', message: 'none' },
        };
      return {
        status: 422,
        body: {
          statusCode: 422,
          errorCode: 'stem_separation_source_not_hosted',
          message: 'Stem separation reads only media hosted in Sync storage.',
        },
      };
    });
    const result = await call('stems_separate', { assetId: VIDEO });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        status: 422,
        code: 'stem_separation_source_not_hosted',
        nextStep: expect.stringContaining('assets_create-upload-url'),
      },
    });
  });

  it.each([
    ['scenes_detect', 'Scene detection'],
    ['stems_separate', 'Stem separation'],
  ])('reports %s as not enabled when its flag is off', async (name, feature) => {
    const { call, calls } = await setup(() => FLAG_OFF);
    const result = await call(name, { assetId: VIDEO, wait: true });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        message: `${feature} isn't enabled for this account yet.`,
        status: 404,
        code: 'feature_not_enabled',
        nextStep: expect.stringContaining('enabled for their account'),
      },
    });
    expect(calls).toHaveLength(1);
  });

  it('reports a missing route as not enabled, but keeps a missing asset as is', async () => {
    let asset = false;
    const { call } = await setup((method, url) =>
      asset
        ? {
            status: 404,
            body: {
              statusCode: 404,
              error: 'Not Found',
              message: `Asset not found for ID: ${VIDEO}`,
            },
          }
        : {
            status: 404,
            body: { statusCode: 404, error: 'Not Found', message: `Cannot ${method} ${url}` },
          },
    );
    const missingRoute = await call('stems_separate', { assetId: VIDEO });
    expect(missingRoute.structuredContent).toMatchObject({
      error: { code: 'feature_not_enabled' },
    });
    asset = true;
    const missingAsset = await call('scenes_detect', { assetId: VIDEO });
    expect(missingAsset.structuredContent).toMatchObject({
      error: { status: 404, message: expect.stringContaining('Asset not found') },
    });
    expect(missingAsset.structuredContent).not.toHaveProperty('error.code');
  });
});
