import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';
import type { AvailableUpdate, UpdateCheck } from './update-check.js';
import { PACKAGE_VERSION } from './version.js';

const spec = {
  openapi: '3.0.0',
  paths: { '/v2/voices': { get: { operationId: 'Voices_getVoices', tags: ['voices'] } } },
};
const UPDATE = { current: '0.1.4', latest: '0.2.0' };
const INSTRUCTION =
  'This sync. MCP server is version 0.1.4; version 0.2.0 is available. Tell the user to update: restart with `npx -y @sync.so/mcp-server@latest` (or reinstall), or switch to the hosted server at https://mcp.sync.so/mcp, which is always current.';
const TOOL_NOTICE =
  'Update available: this sync. MCP server is 0.1.4 and 0.2.0 is out. Tell the user to restart it with `npx -y @sync.so/mcp-server@latest`, or to use the hosted server at https://mcp.sync.so/mcp.';

const connections: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  vi.unstubAllGlobals();
});

function fakeApi() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      calls.push({ url, headers: (options?.headers ?? {}) as Record<string, string> });
      const { pathname } = new URL(url);
      if (pathname === '/api-json') return Response.json(spec);
      if (pathname === '/v2/voices') return Response.json({ voices: [{ id: 'voice' }] });
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  return calls;
}

function fakeUpdateCheck(initial?: AvailableUpdate) {
  let available = initial;
  const check: UpdateCheck = { available: () => available, done: Promise.resolve() };
  return { check, finish: (update: AvailableUpdate) => (available = update) };
}

async function connect(server: McpServer, name = 'claude-code') {
  const client = new Client({ name, version: 'test' });
  connections.push(server, client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function stdioServer(updateCheck?: UpdateCheck) {
  return createSyncMcpServer(
    { baseUrl: 'https://api.test', transport: 'stdio', port: 0, apiKey: 'key' },
    { updateCheck },
  );
}

async function texts(client: Client) {
  const result = await client.callTool({ name: 'voices_get-voices', arguments: {} });
  return {
    texts: (result.content as Array<{ type: string; text: string }>).map((block) => block.text),
    structuredContent: result.structuredContent,
  };
}

describe('update notice', () => {
  it('tells the agent in the instructions and the first tool result only', async () => {
    fakeApi();
    const client = await connect(await stdioServer(fakeUpdateCheck(UPDATE).check));
    expect(client.getInstructions()).toMatch(new RegExp(`same value\\. ${escape(INSTRUCTION)}$`));

    const first = await texts(client);
    expect(first.texts).toHaveLength(2);
    // The JSON text and structuredContent keep their shape; the notice trails them.
    expect(JSON.parse(first.texts[0]!)).toEqual({ voices: [{ id: 'voice' }] });
    expect(first.structuredContent).toEqual({ voices: [{ id: 'voice' }] });
    expect(first.texts[1]).toBe(TOOL_NOTICE);

    expect((await texts(client)).texts).toHaveLength(1);
  });

  it('carries a notice found after the instructions were sent', async () => {
    fakeApi();
    const pending = fakeUpdateCheck();
    const client = await connect(await stdioServer(pending.check));
    expect(client.getInstructions()).not.toContain('@sync.so/mcp-server@latest');
    expect((await texts(client)).texts).toHaveLength(1);

    pending.finish(UPDATE);
    expect((await texts(client)).texts).toEqual([expect.any(String), TOOL_NOTICE]);
    expect((await texts(client)).texts).toHaveLength(1);
  });

  it('adds nothing when no update is available or the check is off', async () => {
    fakeApi();
    const silent = await connect(await stdioServer(fakeUpdateCheck().check));
    const off = await connect(await stdioServer());
    expect(silent.getInstructions()).toBe(off.getInstructions());
    expect(silent.getInstructions()).not.toContain('npx');
    expect((await texts(silent)).texts).toHaveLength(1);
    expect((await texts(off)).texts).toHaveLength(1);
  });

  it('never reaches the hosted server', async () => {
    const calls = fakeApi();
    const config = { baseUrl: 'https://api.test', transport: 'http' as const, port: 0 };
    // Even handed a check, the HTTP transport ignores it.
    const direct = await connect(
      await createSyncMcpServer(config, { updateCheck: fakeUpdateCheck(UPDATE).check }),
      'claude-ai',
    );
    const hosted = await connect(
      (await createMcpServerFactory(config)).createServer(),
      'claude-ai',
    );
    for (const client of [direct, hosted]) {
      expect(client.getInstructions()).not.toContain('@sync.so/mcp-server@latest');
      const result = await runWithAuth('token', 'claude-ai', () => texts(client));
      expect(result.texts).toHaveLength(1);
    }
    // Only the stub API is contacted, never the npm registry.
    expect(new Set(calls.map((call) => new URL(call.url).hostname))).toEqual(new Set(['api.test']));
  });
});

describe('MCP version headers', () => {
  it('sends the server version and the stdio client name on API calls', async () => {
    const calls = fakeApi();
    const client = await connect(await stdioServer(), 'cursor');
    await texts(client);
    expect(calls.find((call) => call.url.endsWith('/v2/voices'))?.headers).toMatchObject({
      'x-api-key': 'key',
      'x-sync-source': 'mcp:cursor',
      'x-sync-mcp-version': PACKAGE_VERSION,
      'x-sync-mcp-client': 'cursor',
    });
  });

  it('sends the version and the session client name from the hosted server', async () => {
    const calls = fakeApi();
    const factory = await createMcpServerFactory({
      baseUrl: 'https://api.test',
      transport: 'http',
      port: 0,
    });
    const client = await connect(factory.createServer(), 'openai-mcp');
    await runWithAuth('token', 'openai-mcp', () => texts(client));
    await runWithAuth('token', undefined, () => texts(client));
    const [named, unnamed] = calls.filter((call) => call.url.endsWith('/v2/voices'));
    expect(named?.headers).toMatchObject({
      Authorization: 'Bearer token',
      'x-sync-source': 'mcp:openai-mcp',
      'x-sync-mcp-version': PACKAGE_VERSION,
      'x-sync-mcp-client': 'openai-mcp',
    });
    expect(unnamed?.headers).toMatchObject({ 'x-sync-mcp-version': PACKAGE_VERSION });
    expect(unnamed?.headers).not.toHaveProperty('x-sync-mcp-client');
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
