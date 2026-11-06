import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Tool } from '@modelcontextprotocol/client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServerFactory, createSyncMcpServer } from '../server.js';
import { descriptorSpec } from '../test-fixtures/descriptor-spec.js';

// Agents pick tools and fill inputs from these descriptors alone, and directories such as
// Glama score them on it: every tool a model sees needs a title, read/write annotations
// and a description on each input. descriptorSpec turns on every feature-gated tool and
// leaves its parameters undescribed, so the server's own text has to cover them.
const spec = descriptorSpec;

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

const EVERY_PROFILE = [
  'lipsync_create',
  'dubbing_create',
  'dialogue-previews_get',
  'dialogue-videos_estimate',
  'speech-previews_get',
  'audio-trims_get',
  'translation-previews_get',
  'generations_get-costs',
  'generations_get-continuation',
  'projects_list-generations',
  'organizations_list',
];
const MODEL_CLIENTS = [
  ...EVERY_PROFILE,
  'lipsync_create-timeline',
  'batches_list',
  'feedback_send',
];
const EXPECTED: Record<string, string[]> = {
  'stdio default': [...MODEL_CLIENTS, 'jobs_wait'],
  'stdio all': [...MODEL_CLIENTS, 'jobs_wait', 'tts-jobs_get'],
  'hosted claude-code': MODEL_CLIENTS,
  'hosted openai-mcp': [...EVERY_PROFILE, 'studio-views_get', 'studio-drafts_get'],
};

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
      // The spec must build every feature-gated tool, or the check below skips them.
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(EXPECTED[profile]!));
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
