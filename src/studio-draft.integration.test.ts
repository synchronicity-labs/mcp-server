import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const draftId = '00000000-0000-4000-8000-000000000002';
const visualId = '00000000-0000-4000-8000-000000000003';

it('routes chat draft edits through the authenticated API without confirming UI application or calling paid tools', async () => {
  const calls: { method?: string; path?: string; auth?: string; body: Record<string, unknown> }[] =
    [];
  let current = {
    id: draftId,
    projectId,
    revision: 4,
    appliedRevision: 4,
    editable: true,
    updatedAt: '2026-10-22T12:00:00.000Z',
    state: {
      workflow: 'lipsync',
      visualId,
      audioId: null,
      model: 'sync-3',
      options: {
        temperature: 0.5,
        model_mode: 'legacy-mode',
        active_speaker_detection: { auto_detect: false, bounding_boxes: [[0, 0, 10, 10]] },
      },
      targetLang: '',
      sourceLang: 'auto',
      speech: { text: '', voiceId: null, stability: 0.5, similarityBoost: 0.75 },
    },
  };
  const stateSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      workflow: {
        type: 'string',
        enum: ['lipsync', 'image_to_video', 'translate_and_dub', 'edit_dialogue'],
      },
      visualId: { type: 'string', nullable: true },
      audioId: { type: 'string', nullable: true },
      model: { type: 'string' },
      targetLang: { type: 'string' },
      sourceLang: { type: 'string' },
      options: {
        type: 'object',
        properties: { temperature: { type: 'number' }, sync_mode: { type: 'string' } },
      },
      speech: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          voiceId: { type: 'string', nullable: true },
          stability: { type: 'number' },
          similarityBoost: { type: 'number' },
        },
        required: ['text', 'voiceId', 'stability', 'similarityBoost'],
      },
    },
    required: [
      'workflow',
      'visualId',
      'audioId',
      'model',
      'options',
      'targetLang',
      'sourceLang',
      'speech',
    ],
  };
  const parameters = ['projectId', 'draftId'].map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  const endpoint = '/v2/projects/{projectId}/studio-drafts/{draftId}';
  const upstream = createServer(asyncRequestListener(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api-json') {
      const operation = (operationId: string, properties?: Record<string, unknown>) => ({
        operationId,
        tags: ['Projects'],
        parameters,
        'x-sync-studio-drafts': 1,
        ...(properties
          ? {
              requestBody: {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties, required: Object.keys(properties) },
                  },
                },
              },
            }
          : {}),
      });
      res.end(
        JSON.stringify({
          openapi: '3.0.0',
          paths: {
            [endpoint]: {
              get: operation('StudioDraftsController_get'),
              put: operation('StudioDraftsController_save', {
                expectedRevision: { type: 'integer' },
                state: stateSchema,
                editable: { type: 'boolean' },
              }),
            },
            [`${endpoint}/acknowledgement`]: {
              post: operation('StudioDraftsController_acknowledge', {
                revision: { type: 'integer' },
              }),
            },
          },
        }),
      );
      return;
    }
    let raw = '';
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
    if (req.url !== `/v2/projects/${projectId}/studio-drafts/${draftId}`) {
      res.statusCode = 500;
      res.end(JSON.stringify({ message: 'Unexpected or paid request' }));
      return;
    }
    if (req.method === 'PUT') {
      current = { ...current, revision: 5, state: body.state };
    }
    res.end(JSON.stringify(current));
  }));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'http',
    port: 0,
  });
  const server = factory.createServer();
  const client = new Client({ name: 'openai-mcp', version: 'draft-sync-test' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const catalog = (await client.listTools()).tools;
    expect(catalog.find((t) => t.name === 'get-studio-draft')).toBeDefined();
    for (const name of ['update-studio-draft', 'save-studio-draft'])
      expect(catalog.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
    expect(catalog.find((tool) => tool.name === 'ack-studio-draft')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(catalog.find((t) => t.name === 'save-studio-draft')?._meta?.ui).toMatchObject({
      visibility: ['app'],
    });
    const result = await runWithAuth('draft-user', 'openai-mcp', () =>
      client.callTool({
        name: 'update-studio-draft',
        arguments: {
          projectId,
          draftId,
          expectedRevision: 4,
          patch: { options: { sync_mode: 'loop' } },
        },
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      revision: 5,
      appliedRevision: 4,
      state: {
        visualId,
        options: {
          temperature: 0.5,
          sync_mode: 'loop',
          model_mode: 'legacy-mode',
          active_speaker_detection: { auto_detect: false, bounding_boxes: [[0, 0, 10, 10]] },
        },
      },
    });
    expect(calls.map((c) => [c.method, c.auth])).toEqual([
      ['GET', 'Bearer draft-user'],
      ['PUT', 'Bearer draft-user'],
    ]);
    expect(calls[1]?.body).toMatchObject({ expectedRevision: 4, editable: true });
    calls.length = 0;
    const stale = await runWithAuth('draft-user', 'openai-mcp', () =>
      client.callTool({
        name: 'update-studio-draft',
        arguments: { projectId, draftId, expectedRevision: 4, patch: { model: 'lipsync-2' } },
      }),
    );
    expect(stale.isError).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    calls.length = 0;
    current.editable = false;
    const busy = await runWithAuth('draft-user', 'openai-mcp', () =>
      client.callTool({
        name: 'update-studio-draft',
        arguments: {
          projectId,
          draftId,
          expectedRevision: 5,
          patch: { speech: { text: 'Do not submit this' } },
        },
      }),
    );
    expect(busy.isError).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    calls.length = 0;
    const invalid = await runWithAuth('draft-user', 'openai-mcp', () =>
      client.callTool({
        name: 'update-studio-draft',
        arguments: { projectId, draftId, expectedRevision: 5, patch: { workflow: 'timeline' } },
      }),
    );
    expect(invalid.isError).toBe(true);
    expect(calls).toEqual([]);
    const nonUiServer = factory.createServer();
    const nonUi = new Client({ name: 'claude', version: 'draft-sync-test' });
    const [nonUiClientTransport, nonUiServerTransport] = InMemoryTransport.createLinkedPair();
    await nonUiServer.connect(nonUiServerTransport);
    await nonUi.connect(nonUiClientTransport);
    try {
      expect(
        (await nonUi.listTools()).tools.some((tool) => tool.name === 'save-studio-draft'),
      ).toBe(false);
      const rejected = await runWithAuth('draft-user', 'claude', () =>
        nonUi.callTool({
          name: 'ack-studio-draft',
          arguments: { projectId, draftId, revision: 5 },
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      await nonUi.close();
      await nonUiServer.close();
    }
  } finally {
    await client.close();
    await server.close();
    upstream.close();
    await once(upstream, 'close');
  }
});
