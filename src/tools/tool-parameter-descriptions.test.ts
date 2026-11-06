import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Tool } from '@modelcontextprotocol/client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServerFactory, createSyncMcpServer } from '../server.js';
import { translationSpec } from '../test-fixtures/translation.js';

// Agents pick tools and fill inputs from these descriptors alone, and directories such as
// Glama score them on it: every tool a model sees needs a title, read/write annotations
// and a description on each input. Spec parameters here carry no descriptions, as most of
// the public API's do, so the server's own text has to cover them.
const op = (operationId: string, parameters: unknown[] = [], body?: Record<string, unknown>) => ({
  operationId,
  parameters,
  tags: [operationId.replace(/Controller_.*/, '').toLowerCase()],
  ...(body && {
    requestBody: {
      content: { 'application/json': { schema: { type: 'object', properties: body } } },
    },
  }),
});
const id = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }];
const query = (...names: string[]) =>
  names.map((name) => ({ name, in: 'query', schema: { type: 'string' } }));
const strings = (...names: string[]) =>
  Object.fromEntries(names.map((name) => [name, { type: 'string' }]));
const assetFilters = query(
  'projectId',
  'userId',
  'limit',
  'cursor',
  'searchQuery',
  'sortBy',
  'types',
);
// The public API describes the estimate's fps and workflow itself.
const estimate = structuredClone(translationSpec.paths['/v2/generate/estimate-cost']);
const estimateBody: Record<string, Record<string, unknown>> = estimate.post.requestBody.content[
  'application/json'
].schema.properties;
estimateBody.fps = { ...estimateBody.fps, description: 'Source video frame rate.' };
estimateBody.workflow = { ...estimateBody.workflow, description: 'Omit for lip-sync only.' };
const spec = {
  openapi: '3.0.0',
  paths: {
    ...translationSpec.paths,
    '/v2/generate/estimate-cost': estimate,
    '/v2/models': { get: op('ModelsController_get') },
    '/v2/voices': { get: op('VoicesController_getVoices', query('provider')) },
    '/v2/assets': {
      get: op('AssetsController_getAll', assetFilters),
      post: op(
        'AssetsController_create',
        [],
        strings('url', 'type', 'name', 'projectId', 'visibility', 'format', 'contentSha256'),
      ),
    },
    '/v2/assets/count': { get: op('AssetsController_count', assetFilters) },
    '/v2/assets/upload': {
      post: op('AssetsController_createUploadUrl', [], strings('fileName', 'contentType', 'size')),
    },
    '/v2/assets/{id}': {
      get: op('AssetsController_get', id),
      patch: op('AssetsController_update', id, strings('name', 'visibility')),
      delete: op('AssetsController_delete', id),
    },
    '/v2/assets/{id}/download': { get: op('AssetsController_getDownloadUrl', id) },
    '/v2/generate': { get: op('GenerateController_getGenerations', query('limit')) },
    '/v2/generate/{id}': { get: op('GenerateController_getGeneration', id) },
    '/v2/projects': {
      get: op('ProjectsController_getAll', query('limit', 'cursor', 'searchQuery', 'sortBy')),
      post: op('ProjectsController_create', [], strings('name', 'description')),
    },
    '/v2/projects/{id}': { get: op('ProjectsController_get', id) },
  },
};

let upstream: Server;
const profiles: Record<string, Tool[]> = {};

async function list(server: McpServer, clientName: string): Promise<Tool[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: '1.0.0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(spec));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const stdio = { baseUrl, apiKey: 'test-key', transport: 'stdio', port: 0, updateCheck: false };
  profiles['stdio default'] = await list(
    await createSyncMcpServer({ ...stdio, transport: 'stdio' }),
    'claude-code',
  );
  profiles['stdio all'] = await list(
    await createSyncMcpServer({ ...stdio, transport: 'stdio', toolsets: ['all'] }),
    'claude-code',
  );
  const hosted = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
  for (const name of ['claude-code', 'openai-mcp'])
    profiles[`hosted ${name}`] = await list(hosted.createServer(name), name);
});

afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

// App-only tools serve the ChatGPT widgets; the model never sees them.
const modelVisible = (tool: Tool) => {
  const visibility = (tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility;
  return !visibility || visibility.includes('model');
};

describe('tool descriptors', () => {
  it.each(['stdio default', 'stdio all', 'hosted claude-code', 'hosted openai-mcp'])(
    '%s: every model-visible tool has a title, annotations and described inputs',
    (profile) => {
      const tools = profiles[profile]!.filter(modelVisible);
      expect(tools.length).toBeGreaterThan(10);
      const undocumented = tools.flatMap((tool) =>
        Object.entries(tool.inputSchema.properties ?? {})
          .filter(([, schema]) => !(schema as { description?: string }).description)
          .map(([name]) => `${tool.name}.${name}`),
      );
      expect(undocumented).toEqual([]);
      for (const tool of tools) {
        expect(tool.title, tool.name).toBeTruthy();
        expect(tool.description?.length, tool.name).toBeGreaterThan(40);
        const { readOnlyHint, destructiveHint } = tool.annotations ?? {};
        expect(readOnlyHint ?? destructiveHint, `${tool.name} annotations`).toBeDefined();
      }
    },
  );
});
