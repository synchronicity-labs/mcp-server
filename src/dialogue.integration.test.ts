import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';
import { routeUploadSourceToFixture } from './test-fixtures/upload-source.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const videoAssetId = '00000000-0000-4000-8000-000000000002';
const transcriptionId = '00000000-0000-4000-8000-000000000003';
const dialogueEditId = '00000000-0000-4000-8000-000000000004';
const uploadedAssetId = '00000000-0000-4000-8000-000000000006';
const externalUrl = 'http://93.184.216.34/external.mp4';
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
    transcriptionJobId: { type: 'string' },
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
  options: {
    denied?: boolean;
    external?: boolean;
    uploadRejected?: boolean;
    mismatched?: boolean;
    lostPreview?: boolean;
    keyedPreview?: boolean;
    rotatingAssetUrl?: boolean;
    previewStatus?: 'COMPLETED' | 'COMPLETED_PARTIAL';
    partialDetail?: {
      slotsTotal: number;
      slotsOk: number;
      failedSlots: { index: number; errorCode: string }[];
    };
  } = {},
) {
  const calls: { path: string; body?: Record<string, unknown>; token?: string; key?: string }[] =
    [];
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api-json') {
      const current = structuredClone(spec);
      if (options.keyedPreview)
        Object.assign(current.paths['/v2/dialogue-edits']!.post!, {
          parameters: [
            { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } },
          ],
        });
      res.end(JSON.stringify(current));
      return;
    }
    if (req.url === '/external.mp4') {
      calls.push({ path: req.url });
      res.setHeader('Content-Type', 'video/mp4');
      res.end('external video bytes');
      return;
    }
    if (req.url === '/storage') {
      let bytes = '';
      for await (const chunk of req) bytes += chunk.toString();
      calls.push({ path: req.url, body: { bytes } });
      res.statusCode = options.uploadRejected ? 403 : 200;
      res.end();
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
      value = {
        id: videoAssetId,
        type: 'VIDEO',
        url: options.external
          ? externalUrl
          : options.rotatingAssetUrl
            ? `${sourceVideoUrl}?read=${calls.length}`
            : sourceVideoUrl,
      };
    else if (req.url === '/v2/assets/upload')
      value = { uploadUrl: `http://${req.headers.host}/storage`, url: sourceVideoUrl };
    else if (req.url === '/v2/assets' || req.url === `/v2/assets/${uploadedAssetId}`)
      value = {
        id: uploadedAssetId,
        type: 'VIDEO',
        url: sourceVideoUrl,
        name: 'Interview.mp4',
        durationSeconds: 2,
      };
    else if (req.url?.startsWith('/v2/transcriptions')) {
      if (req.method === 'POST' && body.sourceVideoUrl !== sourceVideoUrl) {
        res.statusCode = 422;
        res.end(
          JSON.stringify({
            message:
              'Transcription sources must be hosted in sync. labs storage. Upload the file via POST /v2/assets/upload first, then transcribe the returned url.',
          }),
        );
        return;
      }
      value = {
        id: transcriptionId,
        status: 'COMPLETED',
        sourceVideoUrl: options.mismatched ? 'https://cdn.sync.so/other.mp4' : sourceVideoUrl,
        transcript,
      };
    } else if (req.url?.startsWith('/v2/dialogue-edits')) {
      if (req.method === 'POST' && options.lostPreview) {
        res.statusCode = 503;
        res.end(JSON.stringify({ message: 'Unknown outcome' }));
        return;
      }
      value = {
        id: dialogueEditId,
        status: options.previewStatus ?? 'COMPLETED',
        sourceVideoUrl,
        sourceTranscript: transcript,
        edits,
        voiceId: 'original-speaker',
        ...(options.partialDetail ? { partialDetail: options.partialDetail } : {}),
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
    runWithAuth('dialogue-reader', 'openai-mcp', () =>
      client.callTool({ name, arguments: { ...args, projectIntent: 'explicit' } }),
    );
  return { calls, client, call, port: (upstream.address() as AddressInfo).port };
}
it.each([
  undefined,
  'COMPLETED',
  'COMPLETED_PARTIAL',
] as const)('transcribes, preserves preview quality (%s), estimates and submits the canonical preview through MCP', async (previewStatus) => {
  const partialDetail = previewStatus
    ? { slotsTotal: 1, slotsOk: 0, failedSlots: [{ index: 0, errorCode: 'QC_SEAM_STEP' }] }
    : undefined;
  const { calls, client, call } = await fixture({ previewStatus, partialDetail });
  const tools = (await client.listTools()).tools;
  expect(
    tools.find((tool) => tool.name === 'create-dialogue-preview')?._meta?.[
      'openai/widgetAccessible'
    ],
  ).toBe(true);
  for (const tool of tools.filter((candidate) => candidate.name.includes('dialogue')))
    expect(tool.title, tool.name).toBeTruthy();
  expect((await call('create-dialogue-transcription', source)).isError).not.toBe(true);
  expect(calls.find((c) => c.path === '/v2/transcriptions')?.body).toEqual({
    sourceVideoUrl,
    projectId,
    maxSourceSeconds: 600,
  });
  const preview = await call('create-dialogue-preview', { ...source, transcriptionId, edits });
  expect(preview.isError).not.toBe(true);
  const recovered = await call('get-dialogue-preview', { ...source, id: dialogueEditId });
  expect(recovered.isError).not.toBe(true);
  for (const result of [preview, recovered]) {
    if (partialDetail)
      expect(result.structuredContent).toMatchObject({ status: previewStatus, partialDetail });
    else expect(result.structuredContent).not.toHaveProperty('partialDetail');
  }
  expect(calls.find((c) => c.path === '/v2/dialogue-edits')?.body).toEqual({
    sourceVideoUrl,
    projectId,
    transcript,
    edits,
    transcriptionJobId: transcriptionId,
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

it('forwards one frozen keyed preview through explicit recovery even when asset playback signatures rotate', async () => {
  const { call, calls } = await fixture({
    keyedPreview: true,
    rotatingAssetUrl: true,
    lostPreview: true,
  });
  const request = {
    ...source,
    transcriptionId,
    edits,
    idempotencyKey: 'dialogue-preview-recovery',
  };
  expect((await call('create-dialogue-preview', request)).isError).toBe(true);
  expect(calls.filter((c) => c.path === '/v2/dialogue-edits')).toHaveLength(1);
  expect((await call('create-dialogue-preview', request)).isError).toBe(true);
  const writes = calls.filter((c) => c.path === '/v2/dialogue-edits');
  expect(writes).toHaveLength(2);
  expect(writes.map((c) => c.key)).toEqual([
    'dialogue-preview-recovery',
    'dialogue-preview-recovery',
  ]);
  expect(writes[0]!.body).toEqual({
    sourceVideoUrl,
    projectId,
    transcript,
    edits,
    transcriptionJobId: transcriptionId,
  });
  expect(writes[1]!.body).toEqual(writes[0]!.body);
  expect((await call('get-dialogue-options', {})).structuredContent).toMatchObject({
    keyedPreview: true,
  });
});
it('refuses keyed preview admission when the upstream has no idempotency contract', async () => {
  const { call, calls } = await fixture();
  expect(
    (
      await call('create-dialogue-preview', {
        ...source,
        transcriptionId,
        edits,
        idempotencyKey: 'unsupported-recovery',
      })
    ).isError,
  ).toBe(true);
  expect(calls.some((c) => c.path === '/v2/dialogue-edits')).toBe(false);
  expect((await call('get-dialogue-options', {})).structuredContent).toMatchObject({
    keyedPreview: false,
  });
});

it('uploads an external dialogue source before transcribing and uses the uploaded asset through generation', async () => {
  const { calls, call, port } = await fixture({ external: true });
  const transport = routeUploadSourceToFixture(port);
  try {
    expect((await call('create-dialogue-transcription', source)).isError).toBe(true);
    const uploaded = await call('upload-dialogue-source', source);
    expect(uploaded.isError).not.toBe(true);
    expect(uploaded.structuredContent).toMatchObject({
      asset: { id: uploadedAssetId, url: sourceVideoUrl },
    });
    const hosted = { projectId, videoAssetId: uploadedAssetId };
    expect((await call('create-dialogue-transcription', hosted)).isError).not.toBe(true);
    expect(
      (await call('get-dialogue-transcription', { ...hosted, id: transcriptionId })).isError,
    ).not.toBe(true);
    expect(
      (await call('create-dialogue-preview', { ...hosted, transcriptionId, edits })).isError,
    ).not.toBe(true);
    expect(
      (
        await call('create-dialogue-video', {
          ...hosted,
          dialogueEditId,
          model: 'sync-3',
          idempotencyKey: 'external-dialogue',
        })
      ).isError,
    ).not.toBe(true);
    expect(calls.find((c) => c.path === '/storage')?.body).toEqual({
      bytes: 'external video bytes',
    });
    expect(calls.find((c) => c.path === '/v2/assets')?.body).toMatchObject({
      url: sourceVideoUrl,
      type: 'VIDEO',
      projectId,
    });
    expect(
      calls.filter((c) => c.path === '/v2/transcriptions').map((c) => c.body?.sourceVideoUrl),
    ).toEqual([externalUrl, sourceVideoUrl]);
    expect(calls.findIndex((c) => c.path === '/storage')).toBeLessThan(
      calls.findIndex((c) => c.path === '/v2/assets'),
    );
    expect(calls.find((c) => c.path === '/v2/generate')?.body?.input).toEqual([
      { type: 'video', assetId: uploadedAssetId },
    ]);
    expect(
      calls
        .filter((c) => c.path.startsWith('/v2/'))
        .every((c) => c.token === 'Bearer dialogue-reader'),
    ).toBe(true);
  } finally {
    transport.restore();
  }
});
it('does not save an external dialogue source when storage rejects its upload', async () => {
  const { calls, call, port } = await fixture({ external: true, uploadRejected: true });
  const transport = routeUploadSourceToFixture(port);
  try {
    expect((await call('upload-dialogue-source', source)).isError).toBe(true);
    expect(calls.some((c) => c.path === '/storage')).toBe(true);
    expect(calls.some((c) => c.path === '/v2/assets' || c.path === '/v2/transcriptions')).toBe(
      false,
    );
  } finally {
    transport.restore();
  }
});
it('checks source access before downloading an external dialogue video', async () => {
  const { calls, call } = await fixture({ external: true, denied: true });
  expect((await call('upload-dialogue-source', source)).isError).toBe(true);
  expect(calls.some((c) => c.path === '/external.mp4' || c.path === '/v2/assets/upload')).toBe(
    false,
  );
});
