import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { resolveClientProfile } from './client-profile.js';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';
import { UPLOAD_WIDGET_URI } from './tools/upload-widget.js';

const nativeFetch = globalThis.fetch;
const signedUrl = 'https://result.test/a%20b.mp4?X-Amz-Signature=a%2Fb%2Bc&X-Amz-Expires=3600';
const config = { baseUrl: 'https://api.test', transport: 'http' as const, port: 0 };
const spec = {
  openapi: '3.0.0',
  paths: {
    '/v2/voices': { get: { operationId: 'Voices_getVoices', tags: ['voices'] } },
    '/v2/generate/{id}': {
      get: {
        operationId: 'Generate_getGeneration',
        tags: ['generate'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'wait', in: 'query', schema: { type: 'boolean' } },
          { name: 'timeout', in: 'query', schema: { type: 'number' } },
        ],
      },
    },
  },
};
const connections: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  vi.unstubAllGlobals();
});
function fakeApi() {
  const calls: Array<{
    path: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (new URL(url).hostname === '127.0.0.1') return nativeFetch(url, options);
      const path = new URL(url).pathname;
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      const headers = options?.headers as Record<string, string>;
      if (path === '/api-json') return Response.json(spec);
      calls.push({ path, body, headers });
      if (path === '/v2/projects')
        return Response.json(
          options?.method === 'GET' ? { items: [] } : { id: `project:${body.name}` },
        );
      if (path === '/v2/voices') return Response.json({ voices: [{ id: 'real-voice' }] });
      if (path === '/v2/generate') return Response.json({ id: 'generation', status: 'PENDING' });
      if (path === '/v2/generate/generation')
        return Response.json({ id: 'generation', status: 'COMPLETED', outputUrl: signedUrl });
      throw new Error(`Unexpected request ${path}`);
    }),
  );
  return calls;
}
async function connect(
  factory: Awaited<ReturnType<typeof createMcpServerFactory>>,
  name: string,
  overHttp = false,
) {
  const server = factory.createServer();
  connections.push(server);
  const callback = server.server.oninitialized;
  const onInitialized = vi.fn(() => callback?.());
  server.server.oninitialized = onInitialized;
  const client = new Client({ name, version: 'test' });
  connections.push(client);
  if (overHttp) {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await server.connect(transport);
    const app = express();
    app.use(express.json());
    app.all('/mcp', async (req, res) => {
      await runWithAuth(`token-${name}`, name, () => transport.handleRequest(req, res, req.body));
    });
    const http = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => http.once('listening', resolve));
    connections.push({
      close: async () => {
        http.closeAllConnections();
        await new Promise<void>((resolve) => http.close(() => resolve()));
      },
    });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`),
      ),
    );
  } else {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }
  expect(onInitialized).toHaveBeenCalledOnce();
  return { client, server };
}

describe('immutable client profiles', () => {
  it.each([
    'chatgpt',
    'openai',
    'openai-chatgpt',
    'ChatGPT',
  ])('recognizes exact ChatGPT alias %s', (name) => {
    expect(resolveClientProfile(name).name).toBe('chatgpt');
  });
  it.each(['claude', 'claude-ai', 'Claude'])('recognizes exact Claude alias %s', (name) => {
    expect(resolveClientProfile(name).name).toBe('claude');
  });
  it.each([
    'not-claude',
    'claude-desktop-unverified',
    'chatgpt.evil',
    'muse',
    'Meta Muse',
    undefined,
  ])('keeps unverified alias %s generic', (name) => {
    expect(resolveClientProfile(name).defaultProjectName).toBe('Sync generations');
    expect(Object.isFrozen(resolveClientProfile(name))).toBe(true);
  });

  it.each([
    'chatgpt',
    'claude',
    'unknown',
  ])('retains SDK cancellation through the profile wrapper for %s', async (name) => {
    const calls = fakeApi();
    const fetchApi = globalThis.fetch;
    let started!: (signal: AbortSignal) => void;
    const projectStarted = new Promise<AbortSignal>((resolve) => {
      started = resolve;
    });
    let stopped!: () => void;
    const projectStopped = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (new URL(url).pathname === '/v2/projects') {
          const signal = options?.signal;
          if (!signal) throw new Error('Profile wrapper dropped cancellation');
          started(signal);
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(signal.reason);
                stopped();
              },
              { once: true },
            );
          });
        }
        return fetchApi(url, options);
      }),
    );
    const { client } = await connect(await createMcpServerFactory(config), name, true);
    const cancel = new AbortController();
    const call = client.callTool(
      {
        name: 'create-lipsync',
        arguments: { imageAssetId: 'image', script: 'Hello', voiceId: 'real-voice' },
      },
      undefined,
      { signal: cancel.signal },
    );
    const rejected = expect(call).rejects.toThrow();
    const upstreamSignal = await projectStarted;
    cancel.abort(new Error('user cancelled'));
    await rejected;
    await projectStopped;
    expect(upstreamSignal.aborted).toBe(true);
    expect(calls.filter((call) => call.path === '/v2/generate')).toHaveLength(0);
  });

  it('configures concurrent real HTTP sessions before discovery', async () => {
    const calls = fakeApi();
    const factory = await createMcpServerFactory(config);
    const names = ['chatgpt', 'claude', 'unknown'];
    const sessions = await Promise.all(names.map((name) => connect(factory, name, true)));
    await Promise.all(
      sessions.map(async ({ client }, index) => {
        expect((await client.listTools()).tools.length).toBe(index === 0 ? 5 : 3);
        expect((await client.listResources()).resources.length > 0).toBe(index === 0);
        expect(
          (
            await client.callTool({
              name: 'create-lipsync',
              arguments: { imageAssetId: 'image', script: 'Hello', voiceId: 'real-voice' },
            })
          ).isError,
        ).not.toBe(true);
      }),
    );
    const projects = ['ChatGPT generations', 'Claude generations', 'Sync generations'];
    for (const [index, name] of names.entries()) {
      expect(
        calls.find(
          (call) =>
            call.path === '/v2/generate' && call.headers.Authorization === `Bearer token-${name}`,
        )?.body.projectId,
      ).toBe(`project:${projects[index]}`);
    }
  });

  it('isolates concurrent discovery, resources, defaults and auth for different sessions', async () => {
    const calls = fakeApi();
    const factory = await createMcpServerFactory(config);
    const sessions = await Promise.all(
      ['chatgpt', 'claude-ai', 'unverified-muse'].map((name) => connect(factory, name)),
    );
    const names = ['ChatGPT generations', 'Claude generations', 'Sync generations'];
    await Promise.all(
      sessions.map(async ({ client }, index) => {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(
          index === 0
            ? [
                'open-upload-widget',
                'upload-media',
                'create-lipsync',
                'voices_get-voices',
                'generate_get-generation',
              ]
            : ['create-lipsync', 'voices_get-voices', 'generate_get-generation'],
        );
        const create = tools.find((tool) => tool.name === 'create-lipsync')!;
        expect(create.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
        expect(
          tools.find((tool) => tool.name === 'generate_get-generation')?.annotations?.readOnlyHint,
        ).toBe(true);
        expect(create.inputSchema.properties).toHaveProperty('videoUrl');
        expect(Boolean(create.inputSchema.properties?.video)).toBe(index === 0);
        expect(Boolean(create._meta?.['openai/fileParams'])).toBe(index === 0);
        expect(Boolean(create._meta?.['openai/widgetAccessible'])).toBe(index === 0);
        const { resources } = await client.listResources();
        expect(resources.length > 0).toBe(index === 0);
        if (index === 0) {
          expect((await client.readResource({ uri: UPLOAD_WIDGET_URI })).contents.length).toBe(1);
          expect(
            (await client.callTool({ name: 'open-upload-widget', arguments: {} })).isError,
          ).not.toBe(true);
        } else {
          expect(JSON.stringify(tools)).not.toMatch(
            /openai\/|upload-media|assets_create|tts_create|ChatGPT/,
          );
          await expect(client.readResource({ uri: UPLOAD_WIDGET_URI })).rejects.toThrow('Copy ID');
          const denied = await client.callTool({
            name: 'upload-media',
            arguments: {
              mediaType: 'image',
              file: { file_id: 'x', download_url: 'https://media.test/image' },
            },
          });
          expect(denied.isError).toBe(true);
          expect(JSON.stringify(denied)).toContain('Copy ID');
          const widget = await client.callTool({ name: 'open-upload-widget', arguments: {} });
          expect(widget.isError).toBe(true);
          expect(JSON.stringify(widget)).toContain('Copy ID');
          const file = await client.callTool({
            name: 'create-lipsync',
            arguments: {
              image: { file_id: 'x', download_url: 'https://media.test/image' },
              audioAssetId: 'audio',
            },
          });
          expect(file.isError).toBe(true);
          expect(JSON.stringify(file)).toContain('Copy ID');
        }
        const result = await runWithAuth(`token-${index}`, `untrusted-${index}`, () =>
          client.callTool({
            name: 'create-lipsync',
            arguments: { videoAssetId: 'video', audioAssetId: 'audio' },
          }),
        );
        expect(result.isError).not.toBe(true);
        const request = calls.find(
          (call) =>
            call.path === '/v2/generate' && call.headers.Authorization === `Bearer token-${index}`,
        )!;
        expect(request.body.projectId).toBe(`project:${names[index]}`);
      }),
    );
    expect(calls.filter((call) => call.path === '/v2/generate')).toHaveLength(3);
    // Repeated notifications cannot reconfigure the immutable session profile.
    sessions[0]!.server.server.oninitialized?.();
    expect((await sessions[0]!.client.listTools()).tools).toHaveLength(5);
  });

  it.each([
    'chatgpt',
    'claude',
    'unknown',
  ])('supports all URL/asset workflows, explicit project and exact signed results for %s', async (name) => {
    const calls = fakeApi();
    const { client } = await connect(await createMcpServerFactory(config), name);
    const voices = await client.callTool({ name: 'voices_get-voices', arguments: {} });
    expect(JSON.stringify(voices)).toContain('real-voice');
    for (const visual of ['video', 'image']) {
      for (const driver of ['audio', 'script']) {
        for (const source of ['Url', 'AssetId']) {
          const args: Record<string, unknown> = {
            [`${visual}${source}`]:
              source === 'Url' ? `https://media.test/${visual}?signature=a%2Fb` : `${visual}-asset`,
            ...(driver === 'script'
              ? { script: 'Hello', voiceId: 'real-voice' }
              : {
                  [`audio${source}`]:
                    source === 'Url' ? 'https://media.test/audio?signature=c%2Fd' : 'audio-asset',
                }),
            projectName: 'Explicit project',
          };
          const result = await client.callTool({ name: 'create-lipsync', arguments: args });
          expect(result.isError).not.toBe(true);
          const body = calls.filter((call) => call.path === '/v2/generate').at(-1)!.body;
          expect(body).toMatchObject({ projectId: 'project:Explicit project', model: 'sync-3' });
          const input = body.input as Array<Record<string, unknown>>;
          expect(input[0]).toEqual({
            type: visual,
            [source === 'Url' ? 'url' : 'assetId']: args[`${visual}${source}`],
          });
          if (driver === 'script')
            expect(input[1]).toMatchObject({
              type: 'text',
              provider: { name: 'elevenlabs', script: 'Hello', voiceId: 'real-voice' },
            });
          else
            expect(input[1]).toEqual({
              type: 'audio',
              [source === 'Url' ? 'url' : 'assetId']: args[`audio${source}`],
            });
          const poll = await client.callTool({
            name: 'generate_get-generation',
            arguments: { id: 'generation', wait: true, timeout: 55 },
          });
          expect(poll.structuredContent).toMatchObject({ outputUrl: signedUrl });
          expect(JSON.parse((poll.content as Array<{ text: string }>)[0]!.text).outputUrl).toBe(
            signedUrl,
          );
        }
      }
    }
    expect(calls.filter((call) => call.path === '/v2/generate')).toHaveLength(8);
  });

  it('keeps stdio presentation local without contaminating an unknown HTTP session', async () => {
    const calls = fakeApi();
    const stdio = await createSyncMcpServer({ ...config, transport: 'stdio', apiKey: 'fake-key' });
    const { client: stdioClient } = await connect(
      { createServer: () => stdio, toolCount: 5 },
      'claude',
    );
    const { client: httpClient } = await connect(await createMcpServerFactory(config), 'unknown');
    await stdioClient.callTool({
      name: 'create-lipsync',
      arguments: { videoAssetId: 'video', audioAssetId: 'audio' },
    });
    await runWithAuth('http-token', undefined, () =>
      httpClient.callTool({
        name: 'create-lipsync',
        arguments: { videoAssetId: 'video', audioAssetId: 'audio' },
      }),
    );
    const posts = calls.filter((call) => call.path === '/v2/generate');
    expect(posts[0]!.body.projectId).toBe('project:Claude generations');
    expect(posts[1]!.body.projectId).toBe('project:Sync generations');
    expect(posts[1]!.headers).toMatchObject({
      Authorization: 'Bearer http-token',
      'x-sync-source': 'mcp',
    });
  });
});
