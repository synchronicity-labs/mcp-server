import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { asyncRequestListener } from './request-listener.js';
import { translationSpec } from './translation.js';

// A stub Sync API with the batch routes, for batches.integration.test.ts.
const op = (operationId: string, extra: Record<string, unknown> = {}) => ({
  operationId,
  tags: [operationId.replace(/Controller_.*/, '')],
  summary: operationId,
  ...extra,
});
const spec = {
  openapi: '3.0.0',
  components: translationSpec.components,
  paths: {
    ...translationSpec.paths,
    '/v2/batch': {
      post: op('BatchController_createBatch', {
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: {} } } },
        },
      }),
      get: op('BatchController_listBatches'),
    },
    '/v2/batch/{id}': {
      get: op('BatchController_getBatch', {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
  },
};

export const batchPayload = (n: number) => ({
  model: 'sync-3',
  input: [
    { type: 'video', url: `https://cdn.test/v${n}.mp4` },
    { type: 'audio', url: `https://cdn.test/a${n}.wav` },
  ],
});
export const batchItems = (count: number) =>
  Array.from({ length: count }, (_, n) => ({ payload: batchPayload(n) }));

export type BatchApiCall = { method: string; url: string; authorized: boolean; body?: unknown };
export type BatchApiReply = { status?: number; body: unknown };

const RESULT_LINES = [
  {
    request_id: 'item-1',
    endpoint: '/v2/generate',
    status: 'COMPLETED',
    error: null,
    response: { id: 'g-1', status: 'COMPLETED', outputUrl: 'https://cdn.test/out1.mp4' },
  },
  {
    request_id: 'item-2',
    endpoint: '/v2/generate',
    status: 'FAILED',
    error: { code: 'INVALID_INPUT', message: 'no face' },
    response: null,
  },
];

type Route = (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;

/** b-1 runs then completes; b-2 points off the API origin; b-3's result file is oversized. */
function batchReads(baseUrl: () => string): Route {
  let reads = 0;
  // A switch over known ids with literal bodies: the request path never selects what gets
  // called, and nothing from it is echoed back.
  const read = (id: string): unknown => {
    switch (id) {
      case 'b-1': {
        reads += 1;
        const metrics = { total_generations: 20, success_count: reads === 1 ? 5 : 19 };
        return reads === 1
          ? { id: 'b-1', status: 'JOBS_CREATED', metrics, outputUrl: '' }
          : {
              id: 'b-1',
              status: 'COMPLETED',
              metrics: { ...metrics, failed_count: 1 },
              outputUrl: `${baseUrl()}/v2/batches/b-1/result`,
            };
      }
      case 'b-2':
        return { id: 'b-2', status: 'FAILED', outputUrl: 'https://elsewhere.test/o' };
      case 'b-3':
        return { id: 'b-3', status: 'COMPLETED', outputUrl: `${baseUrl()}/v2/batches/b-3/result` };
      default:
        return undefined;
    }
  };
  return (req, res) => {
    if (!req.url?.startsWith('/v2/batch/')) return false;
    const batch = read(req.url.slice('/v2/batch/'.length));
    if (batch === undefined) return false;
    res.end(JSON.stringify(batch));
    return true;
  };
}

async function resultFiles(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  // The public result route redirects to a signed copy of the JSONL file.
  if (req.url === '/v2/batches/b-1/result') {
    res.statusCode = 302;
    res.setHeader('Location', '/signed/out.jsonl');
    res.end();
    return true;
  }
  if (req.url === '/signed/out.jsonl') {
    res.setHeader('Content-Type', 'application/jsonl');
    res.end(RESULT_LINES.map((line) => JSON.stringify(line)).join('\n'));
    return true;
  }
  // Chunked, so no Content-Length: only counting while reading can stop it.
  if (req.url === '/v2/batches/b-3/result') {
    res.on('error', () => {});
    const chunk = `${'x'.repeat(1024 * 1024 - 1)}\n`;
    for (let sent = 0; sent < 24 && !res.destroyed; sent++)
      if (!res.write(chunk)) await once(res, 'drain').catch(() => {});
    res.end();
    return true;
  }
  return false;
}

export async function startBatchApi(
  createReply: BatchApiReply = { status: 201, body: { id: 'b-1', status: 'PENDING' } },
): Promise<{ calls: BatchApiCall[]; baseUrl: string; close: () => Promise<void> }> {
  const calls: BatchApiCall[] = [];
  let baseUrl = '';
  const routes: Route[] = [
    (req, res) => {
      if (req.url !== '/v2/batch' || req.method !== 'POST') return false;
      res.statusCode = createReply.status ?? 201;
      res.end(JSON.stringify(createReply.body));
      return true;
    },
    (req, res) => {
      if (req.url !== '/v2/batch' && !req.url?.startsWith('/v2/batch?')) return false;
      res.end(JSON.stringify([{ id: 'b-1', status: 'PROCESSING' }]));
      return true;
    },
    batchReads(() => baseUrl),
    resultFiles,
  ];
  const upstream: Server = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') return void res.end(JSON.stringify(spec));
      let text = '';
      for await (const chunk of req) text += chunk;
      calls.push({
        method: req.method!,
        url: req.url!,
        authorized: req.headers.authorization !== undefined,
        ...(text ? { body: JSON.parse(text) } : {}),
      });
      for (const route of routes) if (await route(req, res)) return;
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'not found' }));
    }),
  );
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  return {
    calls,
    baseUrl,
    close: async () => {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}
