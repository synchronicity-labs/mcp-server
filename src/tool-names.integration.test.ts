import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import {
  createMcpServerFactory,
  createSyncMcpServer,
  HOSTED_HTTP_TOOL_ALLOWLIST,
} from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';
import { currentTools } from './test-fixtures/tool-names.js';
import {
  currentToolName,
  nameTakenByRenamedTool,
  oldNameAlias,
  previousToolName,
  RENAMED_TOOLS,
  renamedToolNotice,
} from './tool-names.js';
import { operationIdToToolName } from './tools/generator.js';

// Old tool names after the <noun>_<verb> rename: callable, unlisted, and announced.
const spec = {
  openapi: '3.0.0',
  paths: {
    '/v2/projects': { get: { operationId: 'ProjectsController_getAll', tags: ['Projects'] } },
    '/v2/voices': { get: { operationId: 'VoicesController_getVoices', tags: ['Voices'] } },
    '/v2/analytics/chatgpt-events': {
      post: {
        operationId: 'analytics_captureChatgptEvent',
        tags: ['Analytics'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                // The deployed collector's vocabulary: tool names from before the rename.
                properties: { tool_name: { type: 'string', enum: ['projects_get-all'] } },
              },
            },
          },
        },
      },
    },
  },
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

async function api() {
  const events: Record<string, unknown>[] = [];
  const upstream: Server = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') return void res.end(JSON.stringify(spec));
      let raw = '';
      for await (const chunk of req) raw += chunk.toString();
      if (req.url === '/v2/analytics/chatgpt-events') {
        events.push(JSON.parse(raw));
        return void res.end('{}');
      }
      if (req.url?.startsWith('/v2/projects'))
        return void res.end(JSON.stringify({ data: [{ id: 'p-1' }] }));
      res.statusCode = 503;
      res.end(JSON.stringify({ message: 'voices are down' }));
    }),
  );
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  cleanups.push(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  return { events, baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` };
}

async function connect(server: McpServer, name: string) {
  cleanups.push(() => server.close());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name, version: '1.0.0' });
  cleanups.push(() => client.close());
  await client.connect(ct);
  return client;
}

async function hosted(name: string) {
  const { baseUrl, events } = await api();
  const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
  const client = await connect(factory.createServer(), name);
  const call = (tool: string) =>
    runWithAuth('fixture-user', name, () => client.callTool({ name: tool, arguments: {} }));
  return { client, call, events };
}

const texts = (result: { content?: unknown }) =>
  (result.content as { type: string; text: string }[]).map((block) => block.text);

describe('renamed tools', () => {
  it('answers an old name like the new one, unlisted, with a notice naming the new tool', async () => {
    const { client, call } = await hosted('claude-code');
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('projects_list');
    expect(names).not.toContain('projects_get-all');

    const current = await call('projects_list');
    const legacy = await call('projects_get-all');
    expect(legacy.isError).not.toBe(true);
    expect(legacy.structuredContent).toEqual(current.structuredContent);
    expect(texts(legacy)).toEqual([
      ...texts(current),
      renamedToolNotice('projects_get-all', 'projects_list'),
    ]);
    expect(texts(current).join('\n')).not.toContain('is now named');
  });

  it('adds the notice to errors through an old name too', async () => {
    const { call } = await hosted('claude-code');
    const failed = await call('voices_get-voices');
    expect(failed.isError).toBe(true);
    expect(texts(failed).at(-1)).toBe(renamedToolNotice('voices_get-voices', 'voices_list'));
  });

  it('lists the old names widgets call as app-only tools in the ChatGPT app', async () => {
    const { client } = await hosted('openai-mcp');
    const tools = (await client.listTools()).tools;
    const legacy = tools.find((tool) => tool.name === 'projects_get-all');
    const current = tools.find((tool) => tool.name === 'projects_list');
    expect(legacy?._meta).toMatchObject({
      ui: { visibility: ['app'] },
      'openai/widgetAccessible': true,
    });
    expect(legacy?.description).toBe(
      'Deprecated name of projects_list, kept for Sync app widgets. Call projects_list.',
    );
    expect(legacy?.inputSchema).toEqual(current?.inputSchema);
    expect(current?._meta?.ui).toMatchObject({ visibility: ['model', 'app'] });
    // Every old name in the listing is app-only, so the model sees only new names.
    for (const tool of tools.filter((entry) => !currentTools([entry]).length))
      expect(tool._meta?.ui, tool.name).toMatchObject({ visibility: ['app'] });
  });

  it('keeps reporting analytics under the collector’s legacy names', async () => {
    const { call, events } = await hosted('openai-mcp');
    await call('projects_list');
    await expect.poll(() => events.length).toBe(1);
    expect(events[0]).toMatchObject({
      event: 'chatgpt_tool_called',
      tool_name: 'projects_get-all',
    });
  });

  it('keeps generated tools callable by their old names over stdio', async () => {
    const { baseUrl } = await api();
    const server = await createSyncMcpServer({
      apiKey: 'key',
      baseUrl,
      transport: 'stdio',
      port: 0,
    });
    const client = await connect(server, 'claude-code');
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('projects_list');
    expect(names.filter((name) => name in RENAMED_TOOLS && !(name in invert()))).toEqual([]);
    const legacy = await client.callTool({ name: 'projects_get-all', arguments: {} });
    expect(legacy.structuredContent).toEqual({ data: [{ id: 'p-1' }] });
    expect(texts(legacy).at(-1)).toBe(renamedToolNotice('projects_get-all', 'projects_list'));
  });
});

function invert(): Record<string, string> {
  return Object.fromEntries(Object.entries(RENAMED_TOOLS).map(([from, to]) => [to, from]));
}

describe('the rename table', () => {
  it('uses one <noun>_<verb> scheme with unique new names', () => {
    const next = Object.values(RENAMED_TOOLS);
    for (const name of next) expect(name, name).toMatch(/^[a-z0-9-]+_[a-z0-9-]+$/);
    expect(new Set(next).size).toBe(next.length);
    for (const name of HOSTED_HTTP_TOOL_ALLOWLIST)
      expect(name, name).toMatch(/^[a-z0-9-]+_[a-z0-9-]+$/);
  });

  it('maps both ways and reserves new names from raw generated operations', () => {
    expect(currentToolName('create-lipsync')).toBe('lipsync_create');
    expect(currentToolName('jobs_wait')).toBe('jobs_wait');
    expect(previousToolName('dubbing_create')).toBe('create-translate-and-dub');
    expect(previousToolName('jobs_wait')).toBeUndefined();
    expect(oldNameAlias('dubbing_create')).toBe('create-translate-and-dub');
    expect(nameTakenByRenamedTool('studio-views_get')).toBe(true);
    expect(nameTakenByRenamedTool('audio-trims_create')).toBe(true);
    // A derived name that is itself renamed is the tool, not a collision.
    expect(nameTakenByRenamedTool('assets_get-all')).toBe(false);
    expect(nameTakenByRenamedTool('assets_get')).toBe(false);
  });

  it('ends the aliases without undoing the new names', () => {
    const none = new Set<string>();
    expect(oldNameAlias('assets_list', none)).toBeUndefined();
    expect(oldNameAlias('lipsync_create', none)).toBeUndefined();
    // Generated names, reservations and analytics read the permanent table, not the aliases.
    expect(operationIdToToolName('AssetsController_getAll')).toBe('assets_list');
    expect(nameTakenByRenamedTool('studio-views_get')).toBe(true);
    expect(previousToolName('lipsync_create')).toBe('create-lipsync');
  });
});
