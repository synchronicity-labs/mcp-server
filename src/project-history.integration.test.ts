import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { createMcpServerFactory } from './server.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const otherProjectId = '00000000-0000-4000-8000-000000000002';
const generationId = '00000000-0000-4000-8000-000000000003';
const sourceAssetId = '00000000-0000-4000-8000-000000000004';
const sourceUrl = 'https://fixture.invalid/source.mp4?Signature=a%2Fb';
const upstreams: Server[] = [];
const clients: Client[] = [];
const servers: McpServer[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const upstream of upstreams.splice(0)) {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

async function fixture(
  options: {
    supported?: boolean;
    ignoresFilter?: boolean;
    denied?: boolean;
    basePath?: string;
    sourceDenied?: boolean;
    wrongGeneration?: boolean;
  } = {},
) {
  const calls: Array<{ path: string; query: Record<string, string> }> = [];
  const basePath = options.basePath ?? '';
  const rows = [
    {
      id: generationId,
      projectId,
      status: 'COMPLETED',
      outputUrl: 'https://fixture.invalid/video.mp4?Signature=a%2Fb',
    },
  ];
  const upstream = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === `${basePath}/api-json`) {
      res.end(
        JSON.stringify({
          openapi: '3.0.0',
          paths: {
            '/v2/generations': {
              get: {
                operationId: 'GenerateController_getGenerations',
                tags: ['Generate'],
                parameters: [
                  {
                    name: 'limit',
                    in: 'query',
                    schema: { type: 'integer', minimum: 1, maximum: 100 },
                  },
                  { name: 'cursor', in: 'query', schema: { type: 'string' } },
                  ...(options.supported === false
                    ? []
                    : [
                        {
                          name: 'projectId',
                          in: 'query',
                          schema: { type: 'string', format: 'uuid' },
                        },
                      ]),
                ],
              },
            },
            '/v2/projects/{id}': {
              get: {
                operationId: 'ProjectsController_get',
                tags: ['Projects'],
                parameters: [
                  {
                    name: 'id',
                    in: 'path',
                    required: true,
                    schema: { type: 'string', format: 'uuid' },
                  },
                ],
              },
            },
          },
        }),
      );
      return;
    }
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (url.pathname === `${basePath}/v2/projects/${projectId}`) {
      res.statusCode = options.denied ? 404 : 200;
      res.end(
        JSON.stringify(options.denied ? { message: 'Project not found' } : { id: projectId }),
      );
    } else if (url.pathname === `${basePath}/v2/generations/list`) {
      res.end(
        JSON.stringify({
          items: [
            {
              id: options.wrongGeneration ? otherProjectId : generationId,
              projectId: options.ignoresFilter ? otherProjectId : projectId,
              status: 'COMPLETED',
              workflow: 'edit_dialogue',
              modelName: 'sync-3',
              options: {
                sync_mode: 'cut_off',
                model_mode: 'legacy-mode',
                mustNotLeak: 'private-provider-state',
                active_speaker_detection: {
                  auto_detect: true,
                  frame_number: -1.5,
                  mustNotLeak: 'private-provider-state',
                },
              },
              segments: [
                {
                  startTime: 0,
                  endTime: 1,
                  audioInput: { refId: 'take', mustNotLeak: 'private-provider-state' },
                  optionsOverride: { sync_mode: 'cut_off', mustNotLeak: 'private-provider-state' },
                  mustNotLeak: 'private-provider-state',
                },
              ],
              speakers: [
                {
                  id: 'speaker',
                  audio: { refId: 'take' },
                  face: { frame_number: 0, coordinates: [1, 2] },
                },
              ],
              inputs: [{ type: 'video', assetId: sourceAssetId, url: sourceUrl }],
              outputMediaUrl: rows[0]!.outputUrl,
              dialogueEditJobId: generationId,
              renderedFromAssetId: sourceAssetId,
              metadata: { mustNotLeak: 'private-provider-state' },
            },
          ],
        }),
      );
    } else if (url.pathname === `${basePath}/v2/assets/${sourceAssetId}`) {
      res.statusCode = options.sourceDenied ? 404 : 200;
      res.end(
        JSON.stringify(
          options.sourceDenied
            ? { message: 'Asset not found' }
            : {
                id: sourceAssetId,
                type: 'VIDEO',
                url: sourceUrl,
              },
        ),
      );
    } else if (url.pathname === `${basePath}/v2/generations`) {
      res.end(
        JSON.stringify(
          options.ignoresFilter
            ? [...rows, { id: 'foreign-record-must-not-leak', projectId: otherProjectId }]
            : rows,
        ),
      );
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  upstreams.push(upstream);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}${basePath}`,
    transport: 'http',
    port: 0,
  });
  const server = factory.createServer();
  servers.push(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  clients.push(client);
  await client.connect(clientTransport);
  return { client, calls, rows };
}

it.each([
  '',
  '/api-proxy',
])('reads selected-project history with cursor pagination under API base path %j', async (basePath) => {
  const { client, calls, rows } = await fixture({ basePath });
  const tool = (await client.listTools()).tools.find(
    (item) => item.name === 'projects_get-generations',
  );
  expect(tool?.inputSchema.required).toContain('projectId');
  expect(tool?._meta?.['openai/widgetAccessible']).toBe(true);
  const result = await client.callTool({
    name: 'projects_get-generations',
    arguments: { projectId, limit: 2, cursor: generationId },
  });
  expect(result.isError).not.toBe(true);
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(rows, null, 2) }]);
  expect(calls).toEqual([
    { path: `${basePath}/v2/projects/${projectId}`, query: {} },
    { path: `${basePath}/v2/generations`, query: { projectId, limit: '2', cursor: generationId } },
  ]);
});

it('keeps legacy organization history available without advertising unsupported project history', async () => {
  const { client, calls } = await fixture({ supported: false });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toContain('generate_get-generations');
  expect(names).not.toContain('projects_get-generations');
  await expect(
    client.callTool({ name: 'projects_get-generations', arguments: { projectId } }),
  ).rejects.toMatchObject({ code: -32602 });
  expect(calls).toEqual([]);
});

it('rejects a mixed rollout response that ignores the project filter without forwarding records', async () => {
  const { client, calls } = await fixture({ ignoresFilter: true });
  const result = await client.callTool({
    name: 'projects_get-generations',
    arguments: { projectId, limit: 10 },
  });
  expect(calls.some((call) => call.path === '/v2/generations')).toBe(true);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain('foreign-record-must-not-leak');
  expect(JSON.stringify(result)).not.toContain(generationId);
});

it('stops before reading history when the current project access check fails', async () => {
  const { client, calls } = await fixture({ denied: true });
  const result = await client.callTool({
    name: 'projects_get-generations',
    arguments: { projectId, limit: 10 },
  });
  expect(result.isError).toBe(true);
  expect(calls).toEqual([{ path: `/v2/projects/${projectId}`, query: {} }]);
});

it.each([
  '',
  '/api-proxy',
])('reads canonical continuation inputs through existing Studio routes under base path %j without writes', async (basePath) => {
  const { client, calls, rows } = await fixture({ basePath });
  const result = await client.callTool({
    name: 'get-generation-continuation',
    arguments: { projectId, id: generationId },
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    submissionContextVersion: 1,
    generation: {
      id: generationId,
      projectId,
      workflow: 'edit_dialogue',
      outputMediaUrl: rows[0]!.outputUrl,
      inputs: [{ type: 'video', assetId: sourceAssetId, url: sourceUrl }],
      options: {
        sync_mode: 'cut_off',
        model_mode: 'legacy-mode',
        active_speaker_detection: { auto_detect: true, frame_number: -1.5 },
      },
      segments: [
        {
          startTime: 0,
          endTime: 1,
          audioInput: { refId: 'take' },
          optionsOverride: { sync_mode: 'cut_off' },
        },
      ],
      speakers: [
        { id: 'speaker', audio: { refId: 'take' }, face: { frame_number: 0, coordinates: [1, 2] } },
      ],
      dialogueEditJobId: generationId,
      renderedFromAssetId: sourceAssetId,
    },
  });
  expect(JSON.stringify(result)).not.toContain('private-provider-state');
  expect(calls).toEqual([
    { path: `${basePath}/v2/projects/${projectId}`, query: {} },
    {
      path: `${basePath}/v2/generations/list`,
      query: { projectId, ids: generationId, limit: '1' },
    },
    { path: `${basePath}/v2/assets/${sourceAssetId}`, query: {} },
  ]);
});

it.each([
  'denied',
  'ignoresFilter',
  'wrongGeneration',
  'sourceDenied',
] as const)('refuses unsafe continuation read %s without leaking source or output', async (failure) => {
  const { client, calls } = await fixture({ [failure]: true });
  const result = await client.callTool({
    name: 'get-generation-continuation',
    arguments: { projectId, id: generationId },
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain(sourceUrl);
  expect(JSON.stringify(result)).not.toContain('https://fixture.invalid/video.mp4');
  if (failure === 'denied')
    expect(calls).toEqual([{ path: `/v2/projects/${projectId}`, query: {} }]);
  if (failure === 'sourceDenied') expect(calls.at(-1)?.path).toBe(`/v2/assets/${sourceAssetId}`);
  if (failure === 'ignoresFilter' || failure === 'wrongGeneration')
    expect(calls.some((c) => c.path.includes('/assets/'))).toBe(false);
});
