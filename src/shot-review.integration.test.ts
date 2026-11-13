import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyncMcpServer } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

// shots_regenerate and shots_splice calls over stdio with an API key, against a stub API.
// Listing is gated on lipsync_planning, in account-features.integration.test.ts.
const FIRST = '4a1d7c1e-8b6a-4d7e-9f3c-2b5a6c7d8e9f';
const TAKE = '9c2e5f3a-1d4b-4a6c-8e7f-0a1b2c3d4e5f';
const VIDEO = '51ef4ef2-84af-4622-b0d0-c47ac04785da';
const SOURCE_AUDIO = '0b6f7c1e-3d2a-4f5b-8e9c-1a2b3c4d5e6f';
const DUB_AUDIO = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const PROJECT = '3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f';
const ASSET = '6d5c4b3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a';
const BASE = `/v2/generate/${FIRST}`;
const SPLICE = `${BASE}/splice`;

type Route = (method: string, url: string) => { status?: number; body: unknown } | undefined;
type Call = { method: string; url: string; body: unknown; idempotencyKey?: string };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

async function setup(route: Route) {
  const calls: Call[] = [];
  const upstream = createServer(
    asyncRequestListener(async (req, res: ServerResponse) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json')
        return void res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
      let raw = '';
      for await (const chunk of req) raw += chunk.toString();
      // Only the routes under test; stdio startup makes its own background requests.
      if (req.url!.startsWith('/v2/generate'))
        calls.push({
          method: req.method!,
          url: req.url!,
          body: raw ? JSON.parse(raw) : undefined,
          idempotencyKey: req.headers['idempotency-key'] as string | undefined,
        });
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
  const server = await createSyncMcpServer({
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
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
  return { call, calls };
}

/** GET /v2/generate/{id} for a finished render of one video and one audio. */
const firstRender = (extra: Record<string, unknown> = {}) => ({
  id: FIRST,
  status: 'COMPLETED',
  model: 'sync-3',
  projectId: PROJECT,
  input: [
    { type: 'video', assetId: VIDEO, url: 'https://storage.sync.so/org/video.mp4' },
    { type: 'audio', assetId: SOURCE_AUDIO, url: 'https://storage.sync.so/org/audio.wav' },
  ],
  dubAudioAssetId: null,
  outputDuration: 36,
  segments: null,
  ...extra,
});
const started = { id: TAKE, status: 'PENDING', model: 'sync-3', projectId: PROJECT };
const serveFirst =
  (generation: unknown): Route =>
  (method, url) => {
    if (method === 'GET' && url === BASE) return { body: generation };
    if (method === 'POST' && url === '/v2/generate') return { status: 201, body: started };
  };
const spliceJob = (status: string, extra: Record<string, unknown> = {}) => ({
  id: '7d4b8f0e-2c1a-4e3b-9f6d-5a8c7b9e0d1f',
  generationId: FIRST,
  replacements: [{ generationId: TAKE, startFrame: 50, endFrame: 278 }],
  status,
  assetId: null,
  url: null,
  error: null,
  createdAt: '2026-11-12T10:00:00.000Z',
  updatedAt: '2026-11-12T10:00:00.000Z',
  ...extra,
});
const errorText = (result: { content?: unknown }) => JSON.stringify(result.content);

describe('shots_regenerate', () => {
  it('lipsyncs only the given shots of a dub to its dubbed track, in the same project', async () => {
    // A dub's own audio input is the source speech, not what its lips follow.
    const { call, calls } = await setup(
      serveFirst(
        firstRender({
          input: [
            { type: 'video', assetId: VIDEO },
            { type: 'audio', url: 'https://x.test/a' },
          ],
          dubAudioAssetId: DUB_AUDIO,
        }),
      ),
    );

    const result = await call('shots_regenerate', {
      generationId: FIRST,
      fps: 24,
      frameCount: 864,
      idempotencyKey: 'take-2',
      shots: [
        { startFrame: 50, endFrame: 278, occlusionDetection: true },
        { startFrame: 376, endFrame: 730, detectSpeaker: true },
        { startFrame: 838, endFrame: 864 },
      ],
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ id: TAKE, status: 'PENDING' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${BASE}`, 'POST /v2/generate']);
    expect(calls[1]?.idempotencyKey).toBe('take-2');
    expect(calls[1]?.body).toEqual({
      model: 'sync-3',
      input: [
        { type: 'video', assetId: VIDEO },
        { type: 'audio', assetId: DUB_AUDIO, refId: 'audio' },
      ],
      segments: [
        // A segment's endFrame is inclusive; its audio still ends where the shot ends.
        {
          startFrame: 50,
          endFrame: 277,
          audioInput: { refId: 'audio', startTime: 50 / 24, endTime: 278 / 24 },
          optionsOverride: { occlusion_detection_enabled: true },
        },
        {
          startFrame: 376,
          endFrame: 729,
          audioInput: { refId: 'audio', startTime: 376 / 24, endTime: 730 / 24 },
          optionsOverride: { active_speaker_detection: { auto_detect: true } },
        },
        {
          startFrame: 838,
          endFrame: 863,
          audioInput: { refId: 'audio', startTime: 838 / 24, endTime: 36 },
          optionsOverride: {},
        },
      ],
      projectId: PROJECT,
    });
  });

  it('uses the audio input of a plain lipsync', async () => {
    const { call, calls } = await setup(serveFirst(firstRender()));

    await call('shots_regenerate', {
      generationId: FIRST,
      fps: 25,
      frameCount: 900,
      shots: [{ startFrame: 0, endFrame: 50 }],
    });

    expect(calls[1]?.body).toMatchObject({
      input: [
        { type: 'video', assetId: VIDEO },
        { type: 'audio', assetId: SOURCE_AUDIO, refId: 'audio' },
      ],
    });
    expect(calls[1]?.idempotencyKey).toBeUndefined();
  });

  it.each([
    ['a render that is still running', firstRender({ status: 'PROCESSING' }), 'is PROCESSING'],
    [
      'a timeline render',
      firstRender({ segments: [{ startFrame: 0, endFrame: 10 }] }),
      'lipsync_create-timeline',
    ],
    [
      'a render made from a script',
      firstRender({ input: [{ type: 'video', assetId: VIDEO }, { type: 'text' }] }),
      'no saved audio',
    ],
    // Its audio was shorter than the video, so the render was cut and a take would not line up.
    [
      'a render shorter than its video',
      firstRender({ outputDuration: 21.5 }),
      'The first render runs 21.5 s but the video runs 36 s',
    ],
  ])('starts nothing for %s', async (_case, generation, message) => {
    const { call, calls } = await setup(serveFirst(generation));

    const result = await call('shots_regenerate', {
      generationId: FIRST,
      fps: 24,
      frameCount: 864,
      shots: [{ startFrame: 0, endFrame: 50 }],
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(message);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('names a shot out of order or past the last frame before reading anything', async () => {
    const { call, calls } = await setup(serveFirst(firstRender()));
    const regenerate = (shots: { startFrame: number; endFrame: number }[]) =>
      call('shots_regenerate', { generationId: FIRST, fps: 24, frameCount: 864, shots });

    const overlapping = await regenerate([
      { startFrame: 50, endFrame: 278 },
      { startFrame: 200, endFrame: 300 },
    ]);
    const pastTheEnd = await regenerate([{ startFrame: 838, endFrame: 865 }]);

    expect(overlapping.isError).toBe(true);
    expect(errorText(overlapping)).toContain(
      'shots[1].startFrame must be at or after the previous endFrame (278)',
    );
    expect(pastTheEnd.isError).toBe(true);
    expect(errorText(pastTheEnd)).toContain('shots[0].endFrame is past the video');
    expect(calls).toEqual([]);
  });
});

describe('shots_splice', () => {
  const replacements = [{ generationId: TAKE, startFrame: 50, endFrame: 278 }];
  const completed = spliceJob('completed', {
    assetId: ASSET,
    url: 'https://storage.sync.so/org/spliced.mp4',
  });

  it('starts the splice and waits until the final video exists', async () => {
    let polls = 0;
    const { call, calls } = await setup((method, url) => {
      if (url !== SPLICE) return undefined;
      if (method === 'POST') return { status: 202, body: spliceJob('pending') };
      polls += 1;
      return { body: polls > 1 ? completed : spliceJob('processing') };
    });

    const result = await call('shots_splice', { generationId: FIRST, replacements, wait: true });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(completed);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET']);
    expect(calls[0]?.body).toEqual({ replacements });
  });

  it('returns a finished splice from the start call without polling', async () => {
    const { call, calls } = await setup((method, url) =>
      method === 'POST' && url === SPLICE ? { status: 202, body: completed } : undefined,
    );

    const result = await call('shots_splice', { generationId: FIRST, replacements, wait: true });

    expect(result.structuredContent).toEqual(completed);
    expect(calls).toHaveLength(1);
  });

  it('passes on why the takes cannot be spliced', async () => {
    const { call } = await setup(() => ({
      status: 409,
      body: {
        statusCode: 409,
        errorCode: 'generation_not_ready',
        message: 'The generation is still rendering.',
      },
    }));

    const result = await call('shots_splice', { generationId: FIRST, replacements });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { status: 409, code: 'generation_not_ready' },
    });
  });

  it('reports the feature as not enabled when its flag is off', async () => {
    const { call, calls } = await setup(() => ({
      status: 404,
      body: { message: 'Not Found', statusCode: 404 },
    }));

    const result = await call('shots_splice', { generationId: FIRST, replacements });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        message: "Shot review isn't enabled for this account yet.",
        code: 'feature_not_enabled',
      },
    });
    expect(calls).toHaveLength(1);
  });

  it('names the first range out of order without calling the API', async () => {
    const { call, calls } = await setup(() => undefined);

    const result = await call('shots_splice', {
      generationId: FIRST,
      replacements: [
        { generationId: TAKE, startFrame: 376, endFrame: 730 },
        { generationId: TAKE, startFrame: 50, endFrame: 278 },
      ],
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(
      'replacements[1].startFrame must be at or after the previous endFrame (730)',
    );
    expect(calls).toEqual([]);
  });
});
