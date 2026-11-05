import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { SyncMcpConfig } from './config.js';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';
import { translationSpec } from './test-fixtures/translation.js';
import { type Toolset, toolsetInstruction } from './toolsets.js';

// jobs_get/jobs_wait and toolsets end to end: stdio and hosted servers on a stub API.
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const json = (properties: Record<string, unknown>) => ({
  content: { 'application/json': { schema: { type: 'object', properties } } },
});
const op = (operationId: string, extra: Record<string, unknown> = {}) => ({
  operationId,
  // The parser keeps only the API's public tags.
  tags: [
    operationId.startsWith('Tts') ? 'text-to-speech' : operationId.replace(/Controller_.*/, ''),
  ],
  summary: operationId,
  ...extra,
});
const spec = {
  openapi: '3.0.0',
  // POST /v2/generate with dubParams, so dubbing_create is offered.
  components: translationSpec.components,
  paths: {
    ...translationSpec.paths,
    '/v2/models': { get: op('ModelsController_get') },
    '/v2/generate/{id}': {
      get: op('GenerateController_getGeneration', {
        parameters: [
          id,
          { name: 'include', in: 'query', schema: { type: 'string', enum: ['progress'] } },
        ],
      }),
    },
    '/v2/assets': {
      post: op('AssetsController_create', {
        requestBody: json({ url: { type: 'string' }, type: { type: 'string' } }),
      }),
    },
    '/v2/assets/{id}': {
      get: op('AssetsController_get', { parameters: [id] }),
      delete: op('AssetsController_delete', { parameters: [id] }),
    },
    '/v2/projects': { post: op('ProjectsController_create', { requestBody: json({}) }) },
    '/v2/projects/{id}': { delete: op('ProjectsController_delete', { parameters: [id] }) },
    '/v2/projects/{id}/assets': {
      post: op('ProjectsController_attachAsset', {
        parameters: [id],
        requestBody: json({ assetId: { type: 'string' } }),
      }),
    },
    '/v2/transcriptions': {
      post: op('TranscriptionsController_createTranscription', {
        requestBody: json({ sourceVideoUrl: { type: 'string' } }),
      }),
    },
    '/v2/transcriptions/{id}': {
      get: op('TranscriptionsController_getTranscriptionJob', { parameters: [id] }),
    },
    '/v2/voices': {
      get: op('VoicesController_getVoices'),
      post: op('VoicesController_cloneVoice', { requestBody: json({ name: { type: 'string' } }) }),
    },
    '/v2/voices/{id}': { delete: op('VoicesController_deleteVoice', { parameters: [id] }) },
    '/v2/tts': { post: op('TtsController_create', { requestBody: json({}) }) },
  },
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

async function api() {
  const calls: { method: string; url: string }[] = [];
  let generationReads = 0;
  let imports = 0;
  const upstream: Server = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') return void res.end(JSON.stringify(spec));
      for await (const _chunk of req);
      calls.push({ method: req.method!, url: req.url! });
      if (req.url?.startsWith('/v2/generate/g-1')) {
        generationReads += 1;
        return void res.end(
          JSON.stringify(
            generationReads === 1
              ? { id: 'g-1', status: 'PROCESSING', progress: { percent: 30 } }
              : { id: 'g-1', status: 'COMPLETED', outputUrl: 'https://cdn.test/out.mp4' },
          ),
        );
      }
      if (req.url === '/v2/assets' && req.method === 'POST') {
        imports += 1;
        if (imports === 1) {
          res.statusCode = 409;
          res.setHeader('Retry-After', '0');
          return void res.end(
            JSON.stringify({
              errorCode: 'import_in_progress',
              message: 'Importing',
              importJobId: '6f1f8c63-41a4-4f55-9d4e-2f7c1f7b1f10',
              importStatus: 'downloading',
              progress: 40,
            }),
          );
        }
        return void res.end(JSON.stringify({ id: 'asset-1', type: 'VIDEO' }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'not found' }));
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

async function connect(server: McpServer, name = 'claude-code') {
  cleanups.push(() => server.close());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name, version: '1.0.0' });
  cleanups.push(() => client.close());
  await client.connect(ct);
  return client;
}

async function stdio(toolsets?: Toolset[]) {
  const { baseUrl, calls } = await api();
  const config: SyncMcpConfig = { apiKey: 'key', baseUrl, transport: 'stdio', port: 0, toolsets };
  const client = await connect(await createSyncMcpServer(config));
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  return { client, calls, names };
}

async function hostedNames(toolsets: Toolset[] | undefined, clientName: string) {
  const { baseUrl } = await api();
  const config: SyncMcpConfig = { baseUrl, transport: 'http', port: 0, toolsets };
  const client = await connect((await createMcpServerFactory(config)).createServer(), clientName);
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

describe('jobs_wait over stdio', () => {
  it('waits on a generation with progress notifications and the unified shape', async () => {
    const { client, calls } = await stdio();
    const jobs = (await client.listTools()).tools.find((tool) => tool.name === 'jobs_wait');
    expect(jobs?.inputSchema.properties?.kind).toMatchObject({
      enum: ['generation', 'transcription', 'import'],
    });
    expect(jobs?.outputSchema).toBeDefined();

    const progress: { progress: number; message?: string }[] = [];
    const result = await client.callTool(
      { name: 'jobs_wait', arguments: { kind: 'generation', id: 'g-1' } },
      { onprogress: (update) => void progress.push(update) },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      kind: 'generation',
      id: 'g-1',
      status: 'COMPLETED',
      result: expect.objectContaining({
        status: 'COMPLETED',
        outputMediaUrl: 'https://cdn.test/out.mp4',
      }),
    });
    expect(progress).toEqual([
      expect.objectContaining({ progress: 1, message: 'generation processing 30%' }),
    ]);
    expect(calls.map((call) => call.url).filter((url) => url.startsWith('/v2/generate'))).toEqual([
      '/v2/generate/g-1?include=progress',
      '/v2/generate/g-1?include=progress',
    ]);
  });

  it('waits through a social import answering 409 import_in_progress', async () => {
    const { client, calls } = await stdio();
    const progress: string[] = [];
    const result = await client.callTool(
      { name: 'jobs_wait', arguments: { kind: 'import', id: 'https://youtu.be/example' } },
      { onprogress: (update) => void progress.push(update.message ?? '') },
    );
    expect(result.structuredContent).toEqual({
      kind: 'import',
      id: 'https://youtu.be/example',
      status: 'COMPLETED',
      result: { id: 'asset-1', type: 'VIDEO' },
    });
    expect(progress).toEqual(['import processing 40%']);
    expect(calls.filter((call) => call.url === '/v2/assets')).toHaveLength(2);
  });

  it('keeps jobs_get one read: a running import comes back with its pause', async () => {
    const { client } = await stdio();
    const result = await client.callTool({
      name: 'jobs_get',
      arguments: { kind: 'import', id: 'https://youtu.be/example' },
    });
    expect(result.structuredContent).toMatchObject({
      status: 'PROCESSING',
      progress: 40,
      retryAfterMs: 0,
      result: { code: 'import_in_progress', importStatus: 'downloading' },
    });
  });
});

describe('local toolsets', () => {
  const ADMIN = ['assets_delete', 'projects_delete', 'voices_clone', 'voices_delete'];

  it('lists the hosted set without admin tools by default, plus jobs and transcription', async () => {
    const { client, names } = await stdio();
    expect(names).toEqual(
      expect.arrayContaining([
        'jobs_get',
        'jobs_wait',
        'lipsync_create',
        'generations_get',
        'assets_create',
        'projects_create',
        'voices_list',
        'transcriptions_create',
        'transcriptions_get',
      ]),
    );
    for (const name of [...ADMIN, 'generations_create', 'projects_attach-asset', 'tts_create'])
      expect(names, name).not.toContain(name);
    expect(client.getInstructions()).toContain(toolsetInstruction(undefined));
    expect(client.getInstructions()).toContain('SYNC_MCP_TOOLSETS=all');
  });

  it('restores every tool with all, and drops the instructions note', async () => {
    const { client, names } = await stdio(['all']);
    expect(names).toEqual(
      expect.arrayContaining([...ADMIN, 'generations_create', 'tts_create', 'jobs_wait']),
    );
    expect(client.getInstructions()).not.toContain('SYNC_MCP_TOOLSETS');
  });

  it.each<[Toolset[], string[], string[]]>([
    [['lipsync'], ['lipsync_create', 'generations_create'], ['assets_create', 'tts_create']],
    [['dubbing'], ['dubbing_create'], ['lipsync_create', 'assets_create']],
    [['assets'], ['assets_create', 'assets_get'], ['assets_delete', 'projects_create']],
    [['projects'], ['projects_create', 'projects_attach-asset'], ['projects_delete']],
    [['transcription'], ['transcriptions_create'], ['lipsync_create']],
    [['voices'], ['voices_list', 'tts_create'], ['voices_clone']],
    [['admin'], ADMIN, ['lipsync_create', 'assets_create']],
    [['default', 'admin'], [...ADMIN, 'lipsync_create', 'assets_create'], ['tts_create']],
  ])('lists %j', async (toolsets, included, excluded) => {
    const { client, names } = await stdio(toolsets);
    // Job reads and account tools come with every selection.
    expect(names).toEqual(
      expect.arrayContaining([...included, 'jobs_get', 'jobs_wait', 'generations_get']),
    );
    for (const name of excluded) expect(names, name).not.toContain(name);
    expect(client.getInstructions()).toContain(toolsetInstruction(toolsets));
  });

  it('lets jobs_wait reach a kind whose own tools the toolset leaves out', async () => {
    const { client, names } = await stdio(['dubbing']);
    expect(names).not.toContain('assets_create');
    const jobs = (await client.listTools()).tools.find((tool) => tool.name === 'jobs_wait');
    expect(jobs?.inputSchema.properties?.kind).toMatchObject({
      enum: expect.arrayContaining(['import']),
    });
  });
});

describe('hosted listing', () => {
  it.each(['claude-code', 'openai-mcp', 'openai-mcp (Codex)', 'claude-ai'])(
    'is unchanged for %s: no jobs tools, and toolsets are ignored',
    async (clientName) => {
      const names = await hostedNames(undefined, clientName);
      expect(names).not.toContain('jobs_get');
      expect(names).not.toContain('jobs_wait');
      expect(names).toContain('assets_delete');
      expect(await hostedNames(['lipsync'], clientName)).toEqual(names);
    },
  );
});
