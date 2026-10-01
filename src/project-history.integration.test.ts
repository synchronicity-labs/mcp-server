import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, expect, it } from 'vitest';
import { createMcpServerFactory } from './server.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const otherProjectId = '00000000-0000-4000-8000-000000000002';
const generationId = '00000000-0000-4000-8000-000000000003';
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
  options: { supported?: boolean; ignoresFilter?: boolean; denied?: boolean } = {},
) {
  const calls: Array<{ path: string; query: Record<string, string> }> = [];
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
    if (url.pathname === '/api-json') {
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
    if (url.pathname === `/v2/projects/${projectId}`) {
      res.statusCode = options.denied ? 404 : 200;
      res.end(
        JSON.stringify(options.denied ? { message: 'Project not found' } : { id: projectId }),
      );
    } else if (url.pathname === '/v2/generations') {
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
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
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

it('reads selected-project history through the hosted ChatGPT tool with cursor pagination', async () => {
  const { client, calls, rows } = await fixture();
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
    { path: `/v2/projects/${projectId}`, query: {} },
    { path: '/v2/generations', query: { projectId, limit: '2', cursor: generationId } },
  ]);
});

it('keeps legacy organization history available without advertising unsupported project history', async () => {
  const { client, calls } = await fixture({ supported: false });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toContain('generate_get-generations');
  expect(names).not.toContain('projects_get-generations');
  const result = await client.callTool({
    name: 'projects_get-generations',
    arguments: { projectId },
  });
  expect(result.isError).toBe(true);
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
