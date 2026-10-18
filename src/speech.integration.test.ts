import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const jobId = '00000000-0000-4000-8000-000000000002';
const idempotencyKey = '00000000-0000-4000-8000-000000000003';
const input = {
  projectId,
  idempotencyKey,
  script: 'Hello from the studio.',
  voiceId: 'voice-a',
  stability: 0.5,
  similarityBoost: 0.75,
};
const job = {
  id: jobId,
  status: 'PENDING',
  url: null,
  duration: null,
  error: null,
  createdAt: '2026-10-14T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
};
const upstreams: Server[] = [],
  clients: Client[] = [],
  servers: McpServer[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const upstream of upstreams.splice(0)) {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
async function fixture({ denied = false, rejected = false, available = true } = {}) {
  const writes: { key: string | string[] | undefined; body: unknown; token: string | undefined }[] =
    [];
  const paths: string[] = [];
  let reads = 0;
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api-json') {
      res.end(
        JSON.stringify({
          openapi: '3.0.0',
          paths: available
            ? {
                '/v2/tts/jobs': {
                  post: { operationId: 'Tts_createJob', tags: ['Text-to-Speech'] },
                },
                '/v2/tts/jobs/{id}': {
                  get: {
                    operationId: 'Tts_getJob',
                    tags: ['Text-to-Speech'],
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
    paths.push(req.url!);
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    let value: unknown;
    if (req.url === `/v2/projects/${projectId}`) {
      res.statusCode = denied ? 403 : 200;
      value = denied ? { message: 'Project denied' } : { id: projectId };
    } else if (req.url === '/v2/billing') {
      value = {
        plan: 'scale',
        billingVersion: 'v3',
        hasActiveCredits: true,
        freeTtsExhausted: false,
        freeGenerationsExhausted: false,
        paymentFailureCountExceededLimit: false,
        freeMonthlyLimits: {
          generations: { used: 2, max: 3 },
          sync3: { used: 1, max: 1 },
          tts: { used: 3, max: 10 },
        },
        stripeCustomerId: 'private-billing-field',
      };
    } else if (req.method === 'POST' && req.url === '/v2/tts/jobs') {
      writes.push({
        key: req.headers['idempotency-key'],
        body: JSON.parse(raw),
        token: req.headers.authorization,
      });
      res.statusCode = rejected ? 503 : 202;
      value = rejected ? { message: 'Admission temporarily unavailable' } : job;
    } else if (req.url === `/v2/tts/jobs/${jobId}`) {
      reads++;
      value =
        reads === 1
          ? { ...job, status: 'PROCESSING' }
          : {
              ...job,
              status: 'SUCCESS',
              url: 'https://cdn.sync.so/speech.wav',
              duration: 2.5,
              finishedAt: '2026-10-14T00:00:03.000Z',
            };
    } else {
      res.statusCode = 404;
      value = {};
    }
    res.end(JSON.stringify(value));
  });
  upstreams.push(upstream);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'http',
    port: 0,
  });
  const server = factory.createServer();
  servers.push(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  clients.push(client);
  await client.connect(ct);
  const call = (name: string, args: Record<string, unknown>) =>
    runWithAuth('speech-reader', 'openai-mcp', () => client.callTool({ name, arguments: args }));
  return { client, call, writes, paths };
}
it('admits a durable speech preview with caller identity, then polls that job without another synthesis', async () => {
  const { client, call, writes, paths } = await fixture();
  const descriptor = (await client.listTools()).tools.find(
    (t) => t.name === 'create-speech-preview',
  );
  expect(descriptor?._meta?.['openai/widgetAccessible']).toBe(true);
  expect(descriptor?.annotations?.idempotentHint).toBe(true);
  const options = await call('get-speech-options', { projectId });
  expect(options.structuredContent).toMatchObject({
    available: true,
    billingVersion: 'v3',
    plan: 'scale',
    freeGenerationsExhausted: false,
    freeMonthlyLimits: { generations: { used: 2, max: 3 }, sync3: { used: 1, max: 1 } },
  });
  expect(JSON.stringify(options)).not.toContain('private-billing-field');
  expect((await call('create-speech-preview', input)).structuredContent).toMatchObject({
    id: jobId,
    status: 'PENDING',
  });
  expect(
    (await call('get-speech-preview', { projectId, id: jobId })).structuredContent,
  ).toMatchObject({ status: 'PROCESSING' });
  expect(
    (await call('get-speech-preview', { projectId, id: jobId })).structuredContent,
  ).toMatchObject({ status: 'SUCCESS', duration: 2.5 });
  expect(writes).toEqual([
    {
      key: idempotencyKey,
      token: 'Bearer speech-reader',
      body: {
        script: input.script,
        voiceId: input.voiceId,
        provider: 'elevenlabs',
        stability: 0.5,
        similarityBoost: 0.75,
      },
    },
  ]);
  expect(paths.filter((path) => path === `/v2/tts/jobs/${jobId}`)).toHaveLength(2);
});
it('does not retry failed admission and forwards the same identity on explicit reconciliation', async () => {
  const { call, writes } = await fixture({ rejected: true });
  expect((await call('create-speech-preview', input)).isError).toBe(true);
  expect(writes).toHaveLength(1);
  expect((await call('create-speech-preview', input)).isError).toBe(true);
  expect(writes.map((write) => write.key)).toEqual([idempotencyKey, idempotencyKey]);
});
it('blocks speech writes and billing reads when project access is denied', async () => {
  const { call, writes, paths } = await fixture({ denied: true });
  expect((await call('get-speech-options', { projectId })).isError).toBe(true);
  expect((await call('create-speech-preview', input)).isError).toBe(true);
  expect(writes).toHaveLength(0);
  expect(paths).not.toContain('/v2/billing');
  expect(paths).toEqual([`/v2/projects/${projectId}`, `/v2/projects/${projectId}`]);
});
it('does not advertise speech preview when the API lacks durable job support', async () => {
  const { client, writes } = await fixture({ available: false });
  expect((await client.listTools()).tools.filter((t) => t.name.includes('speech'))).toHaveLength(0);
  expect(writes).toHaveLength(0);
});

it.each([
  undefined,
  'invalid-key',
])('rejects a missing or malformed speech key before any upstream call (%s)', async (key) => {
  const { call, writes, paths } = await fixture();
  const { idempotencyKey: _key, ...withoutKey } = input;
  const response = await call('create-speech-preview', {
    ...withoutKey,
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });
  expect(response.isError).toBe(true);
  expect(writes).toHaveLength(0);
  expect(paths).toEqual([]);
});
