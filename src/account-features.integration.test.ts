import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { afterEach, describe, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { HttpSession } from './http-session.js';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

// Feature-gated tools are listed only to accounts whose GET /v2/account features name
// them, over stdio and per hosted session; so is the shots input of both lipsync tools.
const GATED = [
  'scenes_detect',
  'stems_separate',
  'faces_detect',
  'faces_get',
  'faces_get-timeline',
];
const ALL_FEATURES = ['scene_detection', 'stem_separation', 'face_validation', 'lipsync_planning'];
type Account = { status?: number; body: unknown };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

/** A stub API whose /v2/account answer depends on the caller's Authorization header. */
async function stubApi(account: (auth: string | undefined) => Account) {
  const accountReads: (string | undefined)[] = [];
  const upstream = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json')
        return void res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
      if (req.url !== '/v2/account') {
        res.statusCode = 404;
        return void res.end(JSON.stringify({ message: 'Not Found', statusCode: 404 }));
      }
      accountReads.push(req.headers.authorization);
      const answer = account(req.headers.authorization);
      res.statusCode = answer.status ?? 200;
      res.end(JSON.stringify(answer.body));
    }),
  );
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  cleanups.push(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  return { accountReads, baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` };
}

const withFeatures = (features: string[]): Account => ({
  body: { plan: { id: 'pro', name: 'Pro' }, features },
});
const gatedNames = async (client: Client) =>
  (await client.listTools()).tools.map((tool) => tool.name).filter((name) => GATED.includes(name));
const SHOT_TOOLS = ['lipsync_create', 'lipsync_create-timeline'];
// The tools that list the shots input, by name.
const withShots = async (client: Client) =>
  (await client.listTools()).tools
    .filter((tool) => Object.hasOwn(tool.inputSchema.properties ?? {}, 'shots'))
    .map((tool) => tool.name);

async function stdio(account: (auth: string | undefined) => Account) {
  const api = await stubApi(account);
  const server = await createSyncMcpServer({
    apiKey: 'test-key',
    baseUrl: api.baseUrl,
    transport: 'stdio',
    port: 0,
  });
  cleanups.push(() => server.close());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  cleanups.push(() => client.close());
  await client.connect(ct);
  return { client, accountReads: api.accountReads };
}

describe('feature-gated tools over stdio', () => {
  it('lists each tool when the account has its feature, reading features once', async () => {
    const { client, accountReads } = await stdio(() => withFeatures(ALL_FEATURES));
    const tools = (await client.listTools()).tools;
    const inputs = Object.fromEntries(
      tools
        .filter((tool) => GATED.includes(tool.name))
        .map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {})]),
    );
    expect(inputs).toEqual({
      scenes_detect: ['assetId', 'wait'],
      stems_separate: ['assetId', 'wait'],
      faces_detect: ['assetId', 'wait'],
      faces_get: ['assetId', 'frame', 'startFrame', 'endFrame'],
      'faces_get-timeline': ['assetId'],
    });
    for (const tool of tools.filter((candidate) => GATED.includes(candidate.name))) {
      expect(tool.inputSchema.required).toEqual(['assetId']);
      // tool-parameter-descriptions.test.ts lists no gated tool, so check the faces_* inputs.
      if (tool.name.startsWith('faces_'))
        for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {}))
          expect((schema as { description?: string }).description, name).toBeTruthy();
      expect(tool.annotations).toMatchObject({
        readOnlyHint: !['scenes_detect', 'stems_separate', 'faces_detect'].includes(tool.name),
        destructiveHint: false,
      });
    }
    const shots = (name: string) =>
      (tools.find((tool) => tool.name === name)?.inputSchema.properties?.shots ?? {}) as {
        description?: string;
      };
    expect(shots('lipsync_create').description).toContain('faces_get-timeline');
    expect(shots('lipsync_create-timeline').description).toContain(
      'a clip’s endFrame is INCLUSIVE',
    );
    expect(await gatedNames(client)).toEqual(GATED);
    expect(accountReads).toHaveLength(1);
  });

  it.each([
    [['scene_detection'], ['scenes_detect']],
    [['stem_separation'], ['stems_separate']],
    [['face_validation'], ['faces_detect', 'faces_get']],
    [['lipsync_planning'], ['faces_get-timeline']],
    [['face_detection'], []],
    [[], []],
  ])('with features %j lists %j', async (features, listed) => {
    const { client } = await stdio(() => withFeatures(features));
    expect(await gatedNames(client)).toEqual(listed);
    expect(await withShots(client)).toEqual(
      features.includes('lipsync_planning') ? SHOT_TOOLS : [],
    );
  });

  it.each([
    ['an older API without the field', { body: { plan: { id: 'pro', name: 'Pro' } } }],
    ['a malformed field', { body: { features: 'scene_detection' } }],
  ])('hides them for %s, and keeps that answer', async (_case, answer) => {
    const { client, accountReads } = await stdio(() => answer);
    expect(await gatedNames(client)).toEqual([]);
    expect(await gatedNames(client)).toEqual([]);
    expect(accountReads).toHaveLength(1);
  });

  it('hides them when the read fails, and reads again on the next list', async () => {
    let failing = true;
    const { client, accountReads } = await stdio(() =>
      failing
        ? { status: 500, body: { message: 'Internal server error' } }
        : withFeatures(ALL_FEATURES),
    );
    expect(await gatedNames(client)).toEqual([]);
    expect(await withShots(client)).toEqual([]);
    failing = false;
    expect(await gatedNames(client)).toEqual(GATED);
    expect(await gatedNames(client)).toEqual(GATED);
    // One failed read per list until it answers, then one kept answer.
    expect(accountReads).toHaveLength(3);
  });

  it('does not read features when the toolset leaves the tools out', async () => {
    const api = await stubApi(() => withFeatures(['scene_detection', 'stem_separation']));
    const server = await createSyncMcpServer({
      apiKey: 'test-key',
      baseUrl: api.baseUrl,
      transport: 'stdio',
      port: 0,
      toolsets: ['voices'],
    });
    cleanups.push(() => server.close());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    cleanups.push(() => client.close());
    await client.connect(ct);
    expect(await gatedNames(client)).toEqual([]);
    expect(api.accountReads).toEqual([]);
  });
});

describe('feature-gated tools on the hosted server', () => {
  const FEATURES: Record<string, string[]> = {
    'Bearer token-both': ALL_FEATURES,
    'Bearer token-scenes': ['scene_detection'],
    'Bearer token-none': [],
  };

  /** One hosted MCP session over Streamable HTTP, authenticated as `token`. */
  async function hostedSession(
    factory: Awaited<ReturnType<typeof createMcpServerFactory>>,
    clientName: string,
    token: string,
  ) {
    const session = new HttpSession(clientName, factory.createServer, () => {});
    cleanups.push(() => session.close());
    const id = randomUUID();
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, limit: 1000 }));
    app.use(express.json());
    app.all('/mcp', async (req, res) => {
      const initialize = req.body?.method === 'initialize';
      if (initialize) res.setHeader('Mcp-Session-Id', id);
      await runWithAuth(token, clientName, () => session.handleRequest(req, res, initialize));
    });
    const http = app.listen(0, '127.0.0.1');
    await once(http, 'listening');
    cleanups.push(async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });
    const client = new Client({ name: clientName, version: '1.0.0' });
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`),
      ),
    );
    return client;
  }

  it('lists them per account, reading each session’s features once, never for ChatGPT', async () => {
    const api = await stubApi((auth) => withFeatures(FEATURES[auth ?? ''] ?? []));
    const factory = await createMcpServerFactory({
      baseUrl: api.baseUrl,
      transport: 'http',
      port: 0,
    });

    const both = await hostedSession(factory, 'claude-ai', 'token-both');
    const scenes = await hostedSession(factory, 'claude-ai', 'token-scenes');
    const none = await hostedSession(factory, 'claude-ai', 'token-none');
    // Sessions share one descriptor catalog per profile; visibility still follows the account.
    expect(await gatedNames(both)).toEqual(GATED);
    expect(await gatedNames(scenes)).toEqual(['scenes_detect']);
    expect(await gatedNames(none)).toEqual([]);
    expect(await withShots(both)).toEqual(SHOT_TOOLS);
    expect(await withShots(scenes)).toEqual([]);
    expect(await gatedNames(both)).toEqual(GATED);
    expect(api.accountReads).toEqual([
      'Bearer token-both',
      'Bearer token-scenes',
      'Bearer token-none',
    ]);

    const codex = await hostedSession(factory, 'openai-mcp (Codex)', 'token-both');
    expect(await gatedNames(codex)).toEqual(GATED);
    // App profiles also list lipsync_create under its old name, create-lipsync. The timeline
    // tool is not an app tool, so its old name create-timeline-lipsync stays unlisted.
    expect(await withShots(codex)).toEqual([...SHOT_TOOLS, 'create-lipsync']);
    const codexNone = await hostedSession(factory, 'openai-mcp (Codex)', 'token-none');
    expect((await codexNone.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...SHOT_TOOLS, 'create-lipsync']),
    );
    expect(await withShots(codexNone)).toEqual([]);

    // ChatGPT lists neither gated tools nor gated inputs, so it never reads features.
    const chatgpt = await hostedSession(factory, 'openai-mcp', 'token-both');
    expect(await gatedNames(chatgpt)).toEqual([]);
    expect(await withShots(chatgpt)).toEqual([]);
    expect(api.accountReads).toHaveLength(5);
  });

  it('hides them when the account read fails', async () => {
    const api = await stubApi(() => ({ status: 503, body: { message: 'Service Unavailable' } }));
    const factory = await createMcpServerFactory({
      baseUrl: api.baseUrl,
      transport: 'http',
      port: 0,
    });
    const client = await hostedSession(factory, 'claude-ai', 'token-both');
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('lipsync_create');
    expect(names.filter((name) => GATED.includes(name))).toEqual([]);
  });
});
