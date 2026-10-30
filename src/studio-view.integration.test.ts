import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

it('delivers explicit view requests over authenticated HTTP, preserves pending receipts, and hides mount controls from non-UI clients', async () => {
  const viewId = '00000000-0000-4000-8000-000000000001';
  const projectId = '00000000-0000-4000-8000-000000000002';
  const id = '00000000-0000-4000-8000-000000000003';
  const generationId = '00000000-0000-4000-8000-000000000004';
  const calls: { path?: string; auth?: string; body: unknown }[] = [];
  const view = {
    id: viewId,
    revision: 1,
    updatedAt: Date.now(),
    context: { projectId: null, draftId: null, draftRevision: null, busy: false },
    action: null,
  };
  const operation = (operationId: string) => ({
    operationId,
    tags: ['Projects'],
    parameters: [{ name: 'viewId', in: 'path', required: true, schema: { type: 'string' } }],
    'x-sync-studio-views': 1,
  });
  const upstream = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api-json') {
        res.end(
          JSON.stringify({
            openapi: '3.0.0',
            paths: {
              '/v2/studio-views/{viewId}': {
                get: operation('StudioViewsController_get'),
                put: operation('StudioViewsController_register'),
              },
              '/v2/studio-views/{viewId}/actions': {
                post: operation('StudioViewsController_request'),
              },
              '/v2/studio-views/{viewId}/acknowledgement': {
                post: operation('StudioViewsController_acknowledge'),
              },
            },
          }),
        );
        return;
      }
      let raw = '';
      for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url, auth: req.headers.authorization, body });
      if (req.url === `/v2/studio-views/${viewId}/actions`) {
        res.end(
          JSON.stringify({
            ...view,
            revision: 2,
            action: {
              id,
              requestRevision: 1,
              expectedContext: view.context,
              command: body.command,
              expiresAt: Date.now() + 120000,
              status: 'pending',
            },
          }),
        );
      } else if (req.url === `/v2/studio-views/${viewId}`) res.end(JSON.stringify(view));
      else {
        res.statusCode = 500;
        res.end(JSON.stringify({ message: 'Unexpected or paid request' }));
      }
    }),
  );
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'http',
    port: 0,
  });
  const server = factory.createServer();
  const client = new Client({ name: 'openai-mcp', version: 'view-sync-test' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.some((tool) => tool.name === 'request-studio-view-action')).toBe(false);
    expect(tools.find((tool) => tool.name === 'register-studio-view')?._meta?.ui).toMatchObject({
      visibility: ['app'],
    });
    const actions = [
      ['open-studio-project', { type: 'open-project', projectId, workflow: 'lipsync' }, true],
      ['refresh-studio-project', { type: 'refresh-project', projectId }, false],
      ['refresh-studio-assets', { type: 'refresh-assets', projectId }, false],
      ['show-studio-generation', { type: 'open-generation', projectId, generationId }, true],
      [
        'continue-studio-generation',
        {
          type: 'continue-generation',
          projectId,
          generationId,
          workflow: 'lipsync',
          seedSource: 'output',
        },
        true,
      ],
    ] as const;
    for (const [name, { type, ...fields }, destructiveHint] of actions) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(
        [...Object.keys(fields), 'viewId', 'id', 'expectedRevision', 'syncAnalytics'].sort(),
      );
      const input = { viewId, id, expectedRevision: 1, ...fields };
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runWithAuth('view-user', 'openai-mcp', () =>
          client.callTool({ name, arguments: input }),
        );
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          id: viewId,
          action: { id, status: 'pending', command: { type, ...fields } },
        });
        expect(calls.at(-1)).toEqual({
          path: `/v2/studio-views/${viewId}/actions`,
          auth: 'Bearer view-user',
          body: { id, expectedRevision: 1, command: { type, ...fields } },
        });
        expect(result.structuredContent).not.toHaveProperty('mountId');
      }
    }
    expect(calls).toHaveLength(10);
    const invalid = await runWithAuth('view-user', 'openai-mcp', () =>
      client.callTool({
        name: 'continue-studio-generation',
        arguments: {
          viewId,
          id,
          expectedRevision: 1,
          projectId,
          generationId,
          workflow: 'lipsync',
        },
      }),
    );
    expect(invalid.isError).toBe(true);
    expect(calls).toHaveLength(10);
    const nonUiServer = factory.createServer();
    const nonUi = new Client({ name: 'cli', version: 'test' });
    const [nct, nst] = InMemoryTransport.createLinkedPair();
    await nonUiServer.connect(nst);
    await nonUi.connect(nct);
    try {
      const nonUiTools = (await nonUi.listTools()).tools.map((tool) => tool.name);
      expect(nonUiTools).not.toContain('ack-studio-view');
      for (const [name] of actions) expect(nonUiTools).not.toContain(name);
      const rejected = await runWithAuth('view-user', 'cli', () =>
        nonUi.callTool({
          name: 'ack-studio-view',
          arguments: { viewId, mountId: id, id, status: 'applied' },
        }),
      );
      expect(rejected.isError).toBe(true);
      // Hidden Studio bridge tools refuse valid calls from clients without the app UI.
      const hidden = await runWithAuth('view-user', 'cli', () =>
        nonUi.callTool({
          name: 'open-studio-project',
          arguments: {
            viewId,
            id,
            expectedRevision: 1,
            projectId,
            workflow: 'lipsync',
          },
        }),
      );
      expect(hidden.isError).toBe(true);
      expect(calls).toHaveLength(10);
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
