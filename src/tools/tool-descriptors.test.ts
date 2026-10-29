import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServerFactory } from '../server.js';

const op = (operationId: string, parameters: unknown[] = []) => ({
  operationId,
  parameters,
  tags: [operationId.replace(/Controller_.*/, '').toLowerCase()],
});
const id = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }];
// An older API: the generations list has no projectId filter, so project history and
// every optional workflow are absent. TTS and raw generation creation are never hosted.
const spec = {
  openapi: '3.0.0',
  paths: {
    '/v2/models': { get: op('ModelsController_get') },
    '/v2/voices': { get: op('VoicesController_getVoices') },
    '/v2/assets': { get: op('AssetsController_getAll'), post: op('AssetsController_create') },
    '/v2/assets/count': { get: op('AssetsController_count') },
    '/v2/assets/upload': { post: op('AssetsController_createUploadUrl') },
    '/v2/assets/{id}': {
      get: op('AssetsController_get', id),
      patch: op('AssetsController_update', id),
      delete: op('AssetsController_delete', id),
    },
    '/v2/assets/{id}/download': { get: op('AssetsController_getDownloadUrl', id) },
    '/v2/generate': {
      get: op('GenerateController_getGenerations', [
        { name: 'limit', in: 'query', schema: { type: 'number' } },
      ]),
      post: op('GenerateController_createGeneration'),
    },
    '/v2/generate/{id}': { get: op('GenerateController_getGeneration', id) },
    '/v2/generate/estimate-cost': { post: op('GenerateController_estimateCost') },
    '/v2/projects': { get: op('ProjectsController_getAll'), post: op('ProjectsController_create') },
    '/v2/projects/{id}': { get: op('ProjectsController_get', id) },
    '/v2/tts': { post: op('TtsController_create') },
  },
};

// Tool-shaped names: an action verb plus hyphen, or a generated `controller_` prefix.
const TOOL_REFERENCE =
  /\b(?:(?:get|create|open|upload|estimate|refresh|show|continue|update|save|ack|register|rename)-[a-z]+(?:-[a-z]+)*|(?:assets|generate|generations|models|projects|voices|tts)_[a-z]+(?:-[a-z]+)*)\b/g;

// Optional workflow tools the server instructions may name: their rules are gated by
// "when available" at the workflow level, not in every sentence.
const OPTIONAL_INSTRUCTION_TOOLS = new Set([
  'get-generation-costs',
  'continue-studio-generation',
  'create-dialogue-video',
  'create-lipsync-from-assets',
  'create-speech-preview',
  'create-translate-and-dub',
  'create-translation-preview',
  'get-studio-draft',
  'get-studio-view',
  'open-studio-project',
  'projects_get-generations',
  'refresh-studio-assets',
  'refresh-studio-project',
  'show-studio-generation',
  'update-studio-draft',
  'voices_clone-voice',
]);

let upstream: Server;
let client: Client;
let tools: Tool[];
let instructions: string;

beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(spec));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await factory.createServer().connect(serverTransport);
  client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  await client.connect(clientTransport);
  tools = (await client.listTools()).tools;
  instructions = client.getInstructions() ?? '';
});

afterAll(async () => {
  await client.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('ChatGPT tool descriptors', () => {
  it('gives every tool a written title', () => {
    for (const tool of tools) {
      const mechanical = tool.name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.title, tool.name).toBe(tool.title?.toLowerCase());
      expect(tool.title, tool.name).not.toBe(mechanical);
    }
  });

  it('only refers ChatGPT to tools it can call, unless qualified as optional', () => {
    const visible = new Set(tools.map((tool) => tool.name));
    expect(visible.has('projects_get-generations')).toBe(false);
    expect(visible.has('generate_create-generation')).toBe(false);
    for (const name of instructions.match(TOOL_REFERENCE) ?? []) {
      expect(
        visible.has(name) || OPTIONAL_INSTRUCTION_TOOLS.has(name),
        `server instructions refer to unknown ${name}`,
      ).toBe(true);
    }
    let optionalReferences = 0;
    for (const tool of tools) {
      const source = tool.name;
      for (const sentence of (tool.description ?? '').split(/(?<=[.;])\s+/)) {
        for (const name of sentence.match(TOOL_REFERENCE) ?? []) {
          if (visible.has(name)) continue;
          optionalReferences += 1;
          expect(sentence, `${source} refers to unavailable ${name}`).toMatch(/\bavailable\b/i);
        }
      }
    }
    // The minimal catalog must exercise the optional-tool path, including project history.
    expect(optionalReferences).toBeGreaterThan(0);
    expect(tools.find((tool) => tool.name === 'projects_get')?.description).toContain(
      'projects_get-generations when available',
    );
  });

  it('keeps organization member emails out of the model context', () => {
    const creators = tools.find((tool) => tool.name === 'get-asset-creators');
    expect(creators?._meta).toMatchObject({
      ui: { visibility: ['app'] },
      'openai/widgetAccessible': true,
    });
    expect(creators?.description).toContain('email');
  });
});
