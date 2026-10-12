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
const videoAssetId = '00000000-0000-4000-8000-000000000002';
const transcriptionId = '00000000-0000-4000-8000-000000000003';
const dialogueEditId = '00000000-0000-4000-8000-000000000004';
const source = { projectId, videoAssetId };
const sourceVideoUrl = 'https://cdn.sync.so/saved-source.mp4';
const transcript = {
  speakerCount: 1,
  segments: [{ id: 's1', words: [{ id: 'w1', text: 'Hello', startMs: 100, endMs: 500 }] }],
};
const edits = [{ kind: 'change', wordId: 'w1', replacement: 'Hi' }];
const estimate = { estimatedFrameCount: 60, estimatedGenerationCost: 0.32, estimatedCredits: 32 };
const bodies = {
  transcriptions: {
    sourceVideoUrl: { type: 'string' },
    projectId: { type: 'string' },
    maxSourceSeconds: { type: 'number' },
  },
  'dialogue-edits': {
    sourceVideoUrl: { type: 'string' },
    projectId: { type: 'string' },
    transcript: { type: 'object' },
    edits: { type: 'array', items: { type: 'object' } },
    voiceId: { type: 'string' },
    rerunOfJobId: { type: 'string' },
  },
};
const spec = {
  openapi: '3.0.0',
  paths: Object.fromEntries(
    Object.entries(bodies).flatMap(([resource, properties]) => [
      [
        `/v2/${resource}`,
        {
          post: {
            operationId: `${resource}_create`,
            tags: [resource === 'transcriptions' ? 'Transcriptions' : 'Dialogue Edits'],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties,
                    required:
                      resource === 'dialogue-edits'
                        ? ['sourceVideoUrl', 'transcript', 'edits']
                        : ['sourceVideoUrl'],
                  },
                },
              },
            },
          },
        },
      ],
      [
        `/v2/${resource}/{id}`,
        {
          get: {
            operationId: `${resource}_get`,
            tags: [resource === 'transcriptions' ? 'Transcriptions' : 'Dialogue Edits'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          },
        },
      ],
    ]),
  ),
};
const upstreams: Server[] = [],
  clients: Client[] = [],
  servers: McpServer[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const server of upstreams.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function fixture(
  options: { denied?: boolean; mismatched?: boolean; lostPreview?: boolean } = {},
) {
  const calls: { path: string; body?: Record<string, unknown>; token?: string; key?: string }[] =
    [];
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api-json') {
      res.end(JSON.stringify(spec));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({
      path: req.url!,
      body,
      token: req.headers.authorization,
      key: req.headers['idempotency-key'] as string | undefined,
    });
    if (options.denied) {
      res.statusCode = 403;
      res.end(JSON.stringify({ message: 'Project denied' }));
      return;
    }
    let value: unknown;
    if (req.url === `/v2/projects/${projectId}`) value = { id: projectId };
    else if (req.url === `/v2/assets/${videoAssetId}`)
      value = { id: videoAssetId, type: 'VIDEO', url: sourceVideoUrl };
    else if (req.url?.startsWith('/v2/transcriptions'))
      value = {
        id: transcriptionId,
        status: 'COMPLETED',
        sourceVideoUrl: options.mismatched ? 'https://cdn.sync.so/other.mp4' : sourceVideoUrl,
        transcript,
      };
    else if (req.url?.startsWith('/v2/dialogue-edits')) {
      if (req.method === 'POST' && options.lostPreview) {
        res.statusCode = 503;
        res.end(JSON.stringify({ message: 'Unknown outcome' }));
        return;
      }
      value = {
        id: dialogueEditId,
        status: 'COMPLETED',
        sourceVideoUrl,
        sourceTranscript: transcript,
        edits,
        voiceId: 'original-speaker',
      };
    } else if (req.url === '/v2/analyze/cost') value = estimate;
    else if (req.url === '/v2/generate') value = { id: dialogueEditId, status: 'PENDING' };
    else {
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
    runWithAuth('dialogue-reader', 'openai-mcp', () => client.callTool({ name, arguments: args }));
  return { calls, client, call };
}
it('transcribes, previews original-voice word edits, estimates and submits the canonical preview through MCP', async () => {
  const { calls, client, call } = await fixture();
  const tools = (await client.listTools()).tools;
  expect(
    tools.find((tool) => tool.name === 'create-dialogue-preview')?._meta?.[
      'openai/widgetAccessible'
    ],
  ).toBe(true);
  expect((await call('create-dialogue-transcription', source)).isError).not.toBe(true);
  expect(calls.find((c) => c.path === '/v2/transcriptions')?.body).toEqual({
    sourceVideoUrl,
    projectId,
    maxSourceSeconds: 600,
  });
  expect(
    (await call('create-dialogue-preview', { ...source, transcriptionId, edits })).isError,
  ).not.toBe(true);
  expect(calls.find((c) => c.path === '/v2/dialogue-edits')?.body).toEqual({
    sourceVideoUrl,
    projectId,
    transcript,
    edits,
  });
  const input = {
    ...source,
    dialogueEditId,
    model: 'sync-3',
    options: { active_speaker_detection: true },
  };
  expect((await call('estimate-dialogue-video', input)).structuredContent).toEqual(estimate);
  expect(
    (await call('create-dialogue-video', { ...input, idempotencyKey: 'dialogue-request' })).isError,
  ).not.toBe(true);
  const generation = calls.find((c) => c.path === '/v2/generate')!;
  expect(generation.body).toEqual({
    projectId,
    model: 'sync-3',
    input: [{ type: 'video', assetId: videoAssetId }],
    dialogueEdit: { id: dialogueEditId },
    options: { active_speaker_detection: { auto_detect: true } },
  });
  expect(calls.find((c) => c.path === '/v2/analyze/cost')?.body).toEqual(generation.body);
  expect(generation.key).toBe('dialogue-request');
  expect(calls.every((c) => c.token === 'Bearer dialogue-reader')).toBe(true);
});
it.each([
  { denied: true },
  { mismatched: true },
])('blocks preview creation for inaccessible or different source: %j', async (options) => {
  const { call, calls } = await fixture(options);
  expect(
    (await call('create-dialogue-preview', { ...source, transcriptionId, edits })).isError,
  ).toBe(true);
  expect(calls.some((c) => c.path === '/v2/dialogue-edits')).toBe(false);
});
it('does not retry an ambiguous paid preview and reuses the original voice without false rerun lineage', async () => {
  const { call, calls } = await fixture({ lostPreview: true });
  expect(
    (
      await call('create-dialogue-preview', {
        ...source,
        previousPreviewId: dialogueEditId,
        edits: [{ kind: 'change', wordId: 'w1', replacement: 'Welcome' }],
      })
    ).isError,
  ).toBe(true);
  const writes = calls.filter((c) => c.path === '/v2/dialogue-edits');
  expect(writes).toHaveLength(1);
  expect(writes[0]?.body?.voiceId).toBe('original-speaker');
  expect(writes[0]?.body).not.toHaveProperty('rerunOfJobId');
});

it('rejects ambiguous transcript identity before any preview synthesis', async () => {
  const { call, calls } = await fixture();
  const response = await call('create-dialogue-preview', {
    ...source,
    transcriptionId,
    previousPreviewId: dialogueEditId,
    edits,
  });
  expect(response.isError).toBe(true);
  expect(calls.some((call) => call.path === '/v2/dialogue-edits')).toBe(false);
});
