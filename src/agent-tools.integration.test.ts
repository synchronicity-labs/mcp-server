import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyncMcpServer } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

// Generated-tool adapters, server-side waits and send-feedback, over stdio with an API key.
const PROJECT = '3c1f0f4e-1b2d-4c5e-8f6a-7b8c9d0e1f2a';
const ASSET = '51ef4ef2-84af-4622-b0d0-c47ac04785da';
const path = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
const body = (properties: Record<string, unknown>, required: string[] = []) => ({
  content: { 'application/json': { schema: { type: 'object', properties, required } } },
});
const op = (operationId: string, tag: string, extra: Record<string, unknown> = {}) => ({
  operationId,
  tags: [tag],
  summary: operationId,
  ...extra,
});

function spec(feedback: boolean) {
  return {
    openapi: '3.0.0',
    paths: {
      '/v2/projects/{id}': {
        get: op('ProjectsController_get', 'Projects', { parameters: [path('id')] }),
      },
      '/v2/projects/{id}/assets': {
        post: op('ProjectsController_attachAsset', 'Projects', {
          parameters: [path('id')],
          requestBody: body({ assetId: { type: 'string' } }, ['assetId']),
        }),
      },
      '/v2/assets': {
        post: op('AssetsController_create', 'Assets', {
          requestBody: body({ url: { type: 'string' }, type: { type: 'string' } }),
        }),
      },
      '/v2/assets/{id}': {
        get: op('AssetsController_get', 'Assets', { parameters: [path('id')] }),
      },
      '/v2/transcriptions': {
        post: op('TranscriptionsController_createTranscription', 'Transcriptions', {
          requestBody: body({
            sourceVideoUrl: { type: 'string' },
            sourceAudioUrl: { type: 'string' },
          }),
        }),
      },
      '/v2/transcriptions/{id}': {
        get: op('TranscriptionsController_getTranscriptionJob', 'Transcriptions', {
          parameters: [path('id')],
        }),
      },
      ...(feedback
        ? {
            '/v2/feedback': {
              post: op('agentFeedback_submit', 'Feedback', {
                requestBody: body({ kind: { type: 'string' }, message: { type: 'string' } }),
              }),
            },
          }
        : {}),
    },
  };
}

type Call = { method: string; path: string; body: unknown };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

async function setup({ feedback = true, spendConfirmation = true } = {}) {
  const calls: Call[] = [];
  let transcriptReads = 0;
  let importAttempts = 0;
  const upstream: Server = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') return void res.end(JSON.stringify(spec(feedback)));
      let raw = '';
      for await (const chunk of req) raw += chunk.toString();
      calls.push({ method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : undefined });
      if (req.url === `/v2/projects/${PROJECT}/assets`) {
        res.statusCode = 204;
        return void res.end();
      }
      if (req.url === `/v2/assets/${ASSET}`)
        return void res.end(
          JSON.stringify({ id: ASSET, type: 'VIDEO', url: 'https://cdn.example.test/clip.mp4' }),
        );
      if (req.url === '/v2/transcriptions')
        return void res.end(JSON.stringify({ id: 't-1', status: 'PENDING' }));
      if (req.url === '/v2/transcriptions/t-1') {
        transcriptReads += 1;
        return void res.end(
          JSON.stringify({ id: 't-1', status: transcriptReads > 1 ? 'COMPLETED' : 'PROCESSING' }),
        );
      }
      if (req.url === '/v2/assets' && req.method === 'POST') {
        importAttempts += 1;
        if (importAttempts === 1) {
          res.statusCode = 409;
          res.setHeader('Retry-After', '0');
          return void res.end(
            JSON.stringify({ errorCode: 'import_in_progress', message: 'Importing', progress: 40 }),
          );
        }
        return void res.end(JSON.stringify({ id: ASSET, type: 'VIDEO' }));
      }
      if (req.url === '/v2/feedback') {
        res.statusCode = 202;
        return void res.end(JSON.stringify({ id: 'feedback-1', received: true }));
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
  const server = await createSyncMcpServer({
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'stdio',
    port: 0,
    spendConfirmation,
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

describe('agent tool adapters', () => {
  it('names the project projectId on project routes, still accepts id, and reports a 204', async () => {
    const { client, call, calls } = await setup();
    const attach = (await client.listTools()).tools.find((t) => t.name === 'projects_attach-asset');
    expect(Object.keys(attach?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['projectId', 'id', 'assetId']),
    );
    expect(attach?.inputSchema.required ?? []).not.toContain('id');
    expect(attach?.inputSchema.properties).not.toHaveProperty('projectIntent');

    for (const args of [{ projectId: PROJECT }, { id: PROJECT }]) {
      const result = await call('projects_attach-asset', { ...args, assetId: ASSET });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        projectId: PROJECT,
        assetId: ASSET,
        attached: true,
      });
    }
    expect(calls.map((c) => c.path)).toEqual([
      `/v2/projects/${PROJECT}/assets`,
      `/v2/projects/${PROJECT}/assets`,
    ]);
    expect(calls[0]?.body).toEqual({ assetId: ASSET });
    const missing = await call('projects_attach-asset', { assetId: ASSET });
    expect(JSON.stringify(missing.content)).toContain('Pass projectId');
  });

  it('transcribes a saved asset by id and waits for the transcript on the server', async () => {
    const { call, calls } = await setup();
    const created = await call('transcriptions_create-transcription', { assetId: ASSET });
    expect(created.isError).not.toBe(true);
    expect(calls.find((c) => c.path === '/v2/transcriptions')?.body).toEqual({
      sourceVideoUrl: 'https://cdn.example.test/clip.mp4',
    });

    const done = await call('transcriptions_get-transcription-job', { id: 't-1', wait: true });
    expect(
      done.structuredContent ?? JSON.parse((done.content as { text: string }[])[0]!.text),
    ).toMatchObject({
      status: 'COMPLETED',
    });
    expect(calls.filter((c) => c.path === '/v2/transcriptions/t-1')).toHaveLength(2);
  });

  it('keeps importing a social link while it is in progress when asked to wait', async () => {
    const { call, calls } = await setup();
    const asset = await call('assets_create', {
      url: 'https://youtu.be/example',
      type: 'VIDEO',
      wait: true,
    });
    expect(asset.isError).not.toBe(true);
    expect(calls.filter((c) => c.path === '/v2/assets')).toHaveLength(2);
    expect(calls[0]?.body).toEqual({ url: 'https://youtu.be/example', type: 'VIDEO' });
  });

  it('sends feedback with its source and client, only when the API takes it', async () => {
    const { client, call, calls } = await setup();
    expect(client.getInstructions()).toContain('call send-feedback once');
    const result = await call('send-feedback', {
      kind: 'confusing_error',
      message: 'The face rejection did not name the clip.',
      tool: 'create-timeline-lipsync',
      severity: 'major',
    });
    expect(result.structuredContent).toEqual({ id: 'feedback-1', received: true });
    expect(calls.at(-1)).toMatchObject({
      path: '/v2/feedback',
      body: {
        kind: 'confusing_error',
        tool: 'create-timeline-lipsync',
        source: 'mcp',
        mcpVersion: expect.any(String),
        client: { name: 'claude-code' },
      },
    });

    const without = await setup({ feedback: false });
    expect((await without.client.listTools()).tools.map((t) => t.name)).not.toContain(
      'send-feedback',
    );
    expect(without.client.getInstructions()).not.toContain('send-feedback');
  });

  it('drops spend confirmation from instructions and descriptions when the operator turns it off', async () => {
    const { client } = await setup({ spendConfirmation: false });
    expect(client.getInstructions()).toMatch(/^This connection runs unattended automation/);
    const timeline = (await client.listTools()).tools.find(
      (t) => t.name === 'create-timeline-lipsync',
    );
    expect(timeline?.description).not.toContain('Estimate and confirm');
    expect(timeline?.description).toContain('This starts an asynchronous generation');
  });
});
