import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyncMcpServer } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

// faces_* calls over stdio with an API key, against a stub API. Calls are not gated on
// account features (the API decides); listing is, in account-features.integration.test.ts.
const VIDEO = '51ef4ef2-84af-4622-b0d0-c47ac04785da';
const RUN = '0b6f7c1e-3d2a-4f5b-8e9c-1a2b3c4d5e6f';
const FACES = `/v2/assets/${VIDEO}/faces`;

type Route = (method: string, url: string) => { status?: number; body: unknown } | undefined;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

async function setup(route: Route) {
  const calls: string[] = [];
  const upstream = createServer(
    asyncRequestListener(async (req, res: ServerResponse) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json')
        return void res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
      // Only the routes under test; stdio startup makes its own background requests.
      if (req.url!.startsWith('/v2/assets')) calls.push(`${req.method} ${req.url}`);
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

const faceData = (status: string) => ({
  status,
  analysisRunId: status === 'completed' ? RUN : null,
  error: null,
  fps: 25,
  frameCount: 120,
  width: 1080,
  height: 1920,
});
const face = { trackId: 't1', box: [100, 200, 300, 460], center: [200, 330] };
const timeline = {
  ...faceData('completed'),
  shots: [
    { startFrame: 0, endFrame: 48 },
    { startFrame: 48, endFrame: 120 },
  ],
  tracks: [
    {
      trackId: 't1',
      personId: 'p1',
      startFrame: 0,
      endFrame: 48,
      detectedFrames: 47,
      faceHeight: { min: 240, median: 260 },
    },
  ],
  talking: [
    {
      startFrame: 0,
      endFrame: 48,
      speaker: 'SPEAKER_00',
      trackId: 't1',
      point: { frame: 23, x: 640, y: 360 },
      reason: 'lips move',
    },
    {
      startFrame: 48,
      endFrame: 120,
      speaker: null,
      trackId: null,
      point: null,
      reason: 'no speech',
    },
  ],
  voices: [{ startSeconds: 0, endSeconds: 1.92, type: 'speech', speakers: ['SPEAKER_00'] }],
};
// Nest's bare NotFoundException, which a disabled feature flag throws.
const FLAG_OFF = { status: 404, body: { message: 'Not Found', statusCode: 404 } };

describe('face tools', () => {
  it('starts face detection and waits until it completes', async () => {
    let started = false;
    let polls = 0;
    const { call, calls } = await setup((method, url) => {
      if (method === 'POST' && url === FACES) {
        started = true;
        return { status: 202, body: { ...faceData('pending'), frames: [] } };
      }
      if (method === 'GET' && url === `${FACES}?frame=0`) {
        if (!started) return { body: { ...faceData('not_requested'), frames: [] } };
        polls += 1;
        const state = polls > 1 ? 'completed' : 'pending';
        return { body: { ...faceData(state), frames: [{ frame: 0, faces: [face] }] } };
      }
    });
    const result = await call('faces_detect', { assetId: VIDEO, wait: true });
    expect(result.isError).not.toBe(true);
    // Status only: the frame the status read names is not part of the result.
    expect(result.structuredContent).toEqual({ assetId: VIDEO, ...faceData('completed') });
    expect(calls).toEqual([
      `GET ${FACES}?frame=0`,
      `POST ${FACES}`,
      `GET ${FACES}?frame=0`,
      `GET ${FACES}?frame=0`,
    ]);
  });

  it('returns a finished or running detection without starting another', async () => {
    let state = 'completed';
    const { call, calls } = await setup((method) =>
      method === 'GET' ? { body: { ...faceData(state), frames: [] } } : undefined,
    );
    expect((await call('faces_detect', { assetId: VIDEO })).structuredContent).toMatchObject({
      status: 'completed',
    });
    state = 'pending';
    expect((await call('faces_detect', { assetId: VIDEO })).structuredContent).toMatchObject({
      status: 'pending',
    });
    expect(calls.every((request) => request.startsWith('GET'))).toBe(true);
  });

  it('reads the faces in a frame range', async () => {
    const frames = [
      { frame: 10, faces: [face] },
      { frame: 11, faces: [] },
    ];
    const { call, calls } = await setup((method, url) =>
      method === 'GET' && url === `${FACES}?startFrame=10&endFrame=12`
        ? { body: { ...faceData('completed'), frames } }
        : undefined,
    );
    const result = await call('faces_get', { assetId: VIDEO, startFrame: 10, endFrame: 12 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ assetId: VIDEO, ...faceData('completed'), frames });
    expect(calls).toHaveLength(1);
  });

  it('reads the face timeline', async () => {
    const { call } = await setup((method, url) =>
      method === 'GET' && url === `${FACES}/timeline` ? { body: timeline } : undefined,
    );
    const result = await call('faces_get-timeline', { assetId: VIDEO });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ assetId: VIDEO, ...timeline });
  });

  it.each([
    ['faces_detect', 'Face detection', {}],
    ['faces_get', 'Face detection', { frame: 0 }],
    ['faces_get-timeline', 'Face timeline', {}],
  ])('reports %s as not enabled when its flag is off', async (name, feature, frames) => {
    const { call, calls } = await setup(() => FLAG_OFF);
    const result = await call(name, { assetId: VIDEO, ...frames });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        message: `${feature} isn't enabled for this account yet.`,
        status: 404,
        code: 'feature_not_enabled',
      },
    });
    expect(calls).toHaveLength(1);
  });

  it('passes a coded refusal through, such as the two-analyses limit', async () => {
    const { call } = await setup((method) =>
      method === 'GET'
        ? { body: { ...faceData('not_requested'), frames: [] } }
        : {
            status: 429,
            body: { statusCode: 429, message: 'Too many analyses in progress.' },
          },
    );
    const result = await call('faces_detect', { assetId: VIDEO });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { status: 429 } });
  });
});
