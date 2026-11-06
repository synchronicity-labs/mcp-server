import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import * as tokenStore from './auth/token-store.js';
import { resolveClientProfile } from './client-profile.js';
import { GENERATION_STATUS_URI } from './generation-status.js';
import { HttpSession } from './http-session.js';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';
import { currentTools } from './test-fixtures/tool-names.js';
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
  vi.restoreAllMocks();
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
      const raw = options?.body;
      const body = raw ? JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) : {};
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
    const session = new HttpSession(name, factory.createServer, () => {});
    connections.push(session);
    const id = randomUUID();
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, limit: 1000 }));
    app.use(express.json());
    app.all('/mcp', async (req, res) => {
      if (req.method === 'DELETE') {
        await session.close();
        res.status(200).end();
        return;
      }
      const initialize = req.body?.method === 'initialize';
      if (initialize) res.setHeader('Mcp-Session-Id', id);
      await runWithAuth(`token-${name}`, name, () => session.handleRequest(req, res, initialize));
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
  if (!overHttp) expect(onInitialized).toHaveBeenCalledOnce();
  return { client, server };
}

describe('immutable client profiles', () => {
  it('supports the observed Codex app client and its hosted file bridge', () => {
    expect(resolveClientProfile('openai-mcp (Codex)')).toMatchObject({
      name: 'codex',
      supportsAppUi: true,
      supportsUploads: true,
      defaultProjectName: 'Sync generations',
    });
  });
  it.each(['chatgpt', 'openai', 'openai-chatgpt', 'openai-mcp', 'OpenAI-MCP', 'ChatGPT'])(
    'recognizes exact ChatGPT alias %s',
    (name) => {
      expect(resolveClientProfile(name).name).toBe('chatgpt');
    },
  );
  it.each(['claude', 'claude-ai', 'Claude', 'Anthropic/ClaudeAI'])(
    'recognizes exact Claude alias %s',
    (name) => {
      expect(resolveClientProfile(name).name).toBe('claude');
    },
  );
  it.each([
    'not-claude',
    'claude-desktop-unverified',
    'chatgpt.evil',
    'openai-mcp.evil',
    'not-openai-mcp',
    'muse',
    'Meta Muse',
    undefined,
  ])('keeps unverified alias %s generic', (name) => {
    expect(resolveClientProfile(name).defaultProjectName).toBe('Sync generations');
    expect(Object.isFrozen(resolveClientProfile(name))).toBe(true);
  });

  it.each(['chatgpt', 'claude', 'unknown'])(
    'retains SDK cancellation through the profile wrapper for %s',
    async (name) => {
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
          name: 'lipsync_create',
          arguments: { imageAssetId: 'image', script: 'Hello', voiceId: 'real-voice' },
        },
        { signal: cancel.signal },
      );
      const rejected = expect(call).rejects.toThrow();
      const upstreamSignal = await projectStarted;
      cancel.abort(new Error('user cancelled'));
      await rejected;
      await projectStopped;
      expect(upstreamSignal.aborted).toBe(true);
      expect(calls.filter((request) => request.path === '/v2/generate')).toHaveLength(0);
    },
  );

  it('gives Claude the generation status card and nothing else from the app', async () => {
    fakeApi();
    const factory = await createMcpServerFactory(config);
    const { client } = await connect(factory, 'claude-ai');
    const { tools } = await client.listTools();
    const create = tools.find((tool) => tool.name === 'lipsync_create')!;
    expect(create._meta?.ui).toEqual({ resourceUri: GENERATION_STATUS_URI });
    expect(JSON.stringify(tools)).not.toContain('openai/');
    expect(tools.find((tool) => tool.name === 'generations_get')?._meta?.ui).toBeUndefined();
    // The card checks through the old name, so it is listed for the card but not the model.
    const legacy = tools.find((tool) => tool.name === 'generate_get-generation');
    expect(legacy?._meta?.ui).toEqual({ visibility: ['app'] });
    expect(legacy?.inputSchema).toEqual(
      tools.find((tool) => tool.name === 'generations_get')?.inputSchema,
    );
    const card = await client.readResource({ uri: GENERATION_STATUS_URI });
    expect(card.contents[0]).toMatchObject({ uri: GENERATION_STATUS_URI });
    const checked = await client.callTool({
      name: 'generate_get-generation',
      arguments: { id: 'generation' },
    });
    expect(checked.isError).not.toBe(true);
    expect(checked.structuredContent).toMatchObject({ id: 'generation', status: 'COMPLETED' });
    await expect(client.readResource({ uri: UPLOAD_WIDGET_URI })).rejects.toThrow();
  });

  it('keeps the status card from unknown clients', async () => {
    fakeApi();
    const { client } = await connect(await createMcpServerFactory(config), 'unverified-muse');
    const { tools } = await client.listTools();
    expect(JSON.stringify(tools)).not.toContain(GENERATION_STATUS_URI);
    expect(tools.some((tool) => tool.name === 'generate_get-generation')).toBe(false);
    await expect(client.readResource({ uri: GENERATION_STATUS_URI })).rejects.toThrow(
      'app-compatible client',
    );
  });

  it.each(['chatgpt', 'openai-mcp (Codex)', 'claude-ai', 'unknown'])(
    'tells %s to wait for a generation in the same reply',
    async (name) => {
      fakeApi();
      const { client } = await connect(await createMcpServerFactory(config), name);
      expect(client.getInstructions()).toContain(
        'keep waiting in this same reply for up to about 15 minutes',
      );
      expect(client.getInstructions()).toContain('never say you will watch the job');
    },
  );

  it('configures concurrent real HTTP sessions before discovery', async () => {
    const calls = fakeApi();
    const factory = await createMcpServerFactory(config);
    const names = ['chatgpt', 'openai-mcp', 'openai-mcp (Codex)', 'claude', 'unknown'];
    const sessions = await Promise.all(names.map((name) => connect(factory, name, true)));
    await Promise.all(
      sessions.map(async ({ client }, index) => {
        const supportsUploads = index < 3;
        // lipsync_create-timeline stays out of the ChatGPT app listing only.
        const chatgpt = index < 2;
        const tools = currentTools((await client.listTools()).tools);
        expect(tools).toHaveLength((supportsUploads ? 14 : 10) + (chatgpt ? 0 : 1));
        expect(tools.some((tool) => tool.name === 'lipsync_create-timeline')).toBe(!chatgpt);
        expect(tools.some((tool) => tool.name === 'assets_upload')).toBe(supportsUploads);
        expect(tools.some((tool) => tool.name === 'assets_open-upload-widget')).toBe(
          supportsUploads,
        );
        // The initialize response carries the announced client's instructions.
        expect(client.getInstructions()?.includes('When Studio publishes')).toBe(supportsUploads);
        expect(client.getInstructions()).toContain('exactly one visual input');
        const create = tools.find((tool) => tool.name === 'lipsync_create')!;
        expect(create._meta?.['openai/fileParams']).toEqual(
          supportsUploads ? ['video', 'image', 'audio'] : undefined,
        );
        for (const field of ['video', 'image', 'audio']) {
          expect(Boolean(create.inputSchema.properties?.[field])).toBe(supportsUploads);
        }
        const resources = (await client.listResources()).resources.map((resource) => resource.name);
        // Claude renders the generation status card, and only that card.
        expect(resources.includes('sync-generation-status')).toBe(index < 4);
        expect(resources.some((name) => name !== 'sync-generation-status')).toBe(supportsUploads);
        expect(
          (
            await client.callTool({
              name: 'lipsync_create',
              arguments: { imageAssetId: 'image', script: 'Hello', voiceId: 'real-voice' },
            })
          ).isError,
        ).not.toBe(true);
      }),
    );
    const projects = [
      'ChatGPT generations',
      'ChatGPT generations',
      'Sync generations',
      'Claude generations',
      'Sync generations',
    ];
    for (const [index, name] of names.entries()) {
      expect(
        calls.find(
          (call) =>
            call.path === '/v2/generate' && call.headers.Authorization === `Bearer token-${name}`,
        )?.body.projectId,
      ).toBe(`project:${projects[index]}`);
    }
  });

  it.each(['openai-mcp', 'openai-mcp (Codex)'])(
    'accepts hosted file uploads and direct file generation from %s over HTTP',
    async (clientName) => {
      const calls = fakeApi();
      const apiFetch = globalThis.fetch;
      const uploaded: Buffer[] = [];
      const bytes = Buffer.from('host-provided test media');
      const file = {
        file_id: 'file-test',
        download_url: 'https://files.test/media.mp4',
        mime_type: 'video/mp4',
        file_name: 'media.mp4',
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          if (url === file.download_url) {
            expect(headers.has('authorization')).toBe(false);
            return new Response(bytes, { headers: { 'content-type': file.mime_type } });
          }
          if (url === 'https://storage.test/upload') {
            expect(headers.has('authorization')).toBe(false);
            expect(init?.method).toBe('PUT');
            if (!(init?.body instanceof Readable)) throw new Error('Expected streamed upload');
            const chunks: Buffer[] = [];
            for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
            uploaded.push(Buffer.concat(chunks));
            return new Response(null, { status: 200 });
          }
          if (url === 'https://api.test/v2/assets/upload' || url === 'https://api.test/v2/assets') {
            expect(headers.get('authorization')).toBe(`Bearer token-${clientName}`);
            expect(headers.get('x-sync-source')).toBe(`mcp:${clientName}`);
            const body = JSON.parse(
              typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body),
            );
            if (url.endsWith('/upload')) {
              expect(body).toEqual({
                fileName: file.file_name,
                contentType: file.mime_type,
                size: bytes.byteLength,
              });
              return Response.json({
                uploadUrl: 'https://storage.test/upload',
                url: 'https://storage.test/media.mp4',
              });
            }
            expect(body).toEqual({ url: 'https://storage.test/media.mp4', type: 'VIDEO' });
            expect(uploaded.at(-1)).toEqual(bytes);
            return Response.json({ id: 'uploaded-video' });
          }
          return apiFetch(url, init);
        }),
      );
      const factory = await createMcpServerFactory(config);
      const { client } = await connect(factory, clientName, true);
      const { tools } = await client.listTools();
      expect(
        tools.find((tool) => tool.name === 'assets_upload')?._meta?.['openai/fileParams'],
      ).toEqual(['file']);
      expect(
        tools.find((tool) => tool.name === 'lipsync_create')?._meta?.['openai/fileParams'],
      ).toEqual(['video', 'image', 'audio']);
      expect((await client.readResource({ uri: UPLOAD_WIDGET_URI })).contents).toHaveLength(1);
      expect(
        (await client.callTool({ name: 'assets_open-upload-widget', arguments: {} })).isError,
      ).not.toBe(true);

      const result = await client.callTool({
        name: 'assets_upload',
        arguments: { mediaType: 'video', file },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        assetId: 'uploaded-video',
        mediaType: 'video',
      });
      expect(uploaded).toEqual([bytes]);
      expect(calls.some((call) => call.path === '/v2/generate')).toBe(false);

      const generation = await client.callTool({
        name: 'lipsync_create',
        arguments: { video: file, audioAssetId: 'audio' },
      });
      expect(generation.isError).not.toBe(true);
      expect(uploaded).toEqual([bytes, bytes]);
      expect(calls.find((call) => call.path === '/v2/generate')?.body).toMatchObject({
        input: [
          { type: 'video', assetId: 'uploaded-video' },
          { type: 'audio', assetId: 'audio' },
        ],
      });

      // The client name does not bypass the SDK schema or the fetchable-URL check.
      for (const invalid of [
        '/tmp/media.mp4',
        { download_url: file.download_url },
        { ...file, download_url: 'file:///tmp/media.mp4' },
      ]) {
        const rejected = await client.callTool({
          name: 'assets_upload',
          arguments: { mediaType: 'video', file: invalid },
        });
        expect(rejected.isError).toBe(true);
      }
      expect(uploaded).toHaveLength(2);
    },
  );

  it('isolates concurrent discovery, resources, defaults and auth for different sessions', async () => {
    const calls = fakeApi();
    const factory = await createMcpServerFactory(config);
    const sessions = await Promise.all(
      ['chatgpt', 'claude-ai', 'unverified-muse'].map((name) => connect(factory, name)),
    );
    const names = ['ChatGPT generations', 'Claude generations', 'Sync generations'];
    await Promise.all(
      sessions.map(async ({ client }, index) => {
        const tools = currentTools((await client.listTools()).tools);
        expect(tools.map((tool) => tool.name)).toEqual(
          index === 0
            ? [
                'assets_open-upload-widget',
                'account_get-context',
                'organizations_list',
                'organizations_select',
                'account_get-usage',
                'projects_rename',
                'assets_list-creators',
                'assets_get-playback-metadata',
                'generations_get-continuation',
                'assets_upload',
                'lipsync_create',
                'lipsync_create-from-assets',
                'voices_list',
                'generations_get',
              ]
            : [
                'account_get-context',
                'organizations_list',
                'organizations_select',
                'account_get-usage',
                'projects_rename',
                'assets_get-playback-metadata',
                'generations_get-continuation',
                'lipsync_create',
                'lipsync_create-timeline',
                'voices_list',
                'generations_get',
              ],
        );
        const create = tools.find((tool) => tool.name === 'lipsync_create')!;
        expect(create.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
        expect(
          tools.find((tool) => tool.name === 'generations_get')?.annotations?.readOnlyHint,
        ).toBe(true);
        expect(create.inputSchema.properties).toHaveProperty('videoUrl');
        expect(Boolean(create.inputSchema.properties?.video)).toBe(index === 0);
        expect(Boolean(create._meta?.['openai/fileParams'])).toBe(index === 0);
        expect(Boolean(create._meta?.['openai/widgetAccessible'])).toBe(index === 0);
        const resources = (await client.listResources()).resources.map((resource) => resource.name);
        expect(resources.includes('sync-generation-status')).toBe(index < 2);
        expect(resources.some((name) => name !== 'sync-generation-status')).toBe(index === 0);
        if (index === 0) {
          expect((await client.readResource({ uri: UPLOAD_WIDGET_URI })).contents).toHaveLength(1);
          expect(
            (await client.callTool({ name: 'assets_open-upload-widget', arguments: {} })).isError,
          ).not.toBe(true);
        } else {
          expect(JSON.stringify(tools)).not.toMatch(
            /openai\/|assets_upload|assets_create|tts_create|ChatGPT/,
          );
          await expect(client.readResource({ uri: UPLOAD_WIDGET_URI })).rejects.toThrow(
            'assets_create-upload-url',
          );
          const denied = await client.callTool({
            name: 'assets_upload',
            arguments: {
              mediaType: 'image',
              file: { file_id: 'x', download_url: 'https://media.test/image' },
            },
          });
          expect(denied.isError).toBe(true);
          expect(JSON.stringify(denied)).toContain('assets_create-upload-url');
          const widget = await client.callTool({
            name: 'assets_open-upload-widget',
            arguments: {},
          });
          expect(widget.isError).toBe(true);
          expect(JSON.stringify(widget)).toContain('assets_create-upload-url');
          const file = await client.callTool({
            name: 'lipsync_create',
            arguments: {
              image: { file_id: 'x', download_url: 'https://media.test/image' },
              audioAssetId: 'audio',
            },
          });
          expect(file.isError).toBe(true);
          expect(JSON.stringify(file)).toContain('assets_create-upload-url');
          // Widget-only tools stay registered but refuse model-only clients before any request.
          const before = calls.length;
          const creators = await runWithAuth(`token-${index}`, `untrusted-${index}`, () =>
            client.callTool({ name: 'assets_list-creators', arguments: {} }),
          );
          expect(creators.isError).toBe(true);
          expect(calls).toHaveLength(before);
        }
        const result = await runWithAuth(`token-${index}`, `untrusted-${index}`, () =>
          client.callTool({
            name: 'lipsync_create',
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
    expect(currentTools((await sessions[0]!.client.listTools()).tools)).toHaveLength(14);
  });

  it.each(['chatgpt', 'claude', 'unknown'])(
    'supports all URL/asset workflows, explicit project and exact signed results for %s',
    async (name) => {
      const calls = fakeApi();
      const { client } = await connect(await createMcpServerFactory(config), name);
      const voices = await client.callTool({ name: 'voices_list', arguments: {} });
      expect(JSON.stringify(voices)).toContain('real-voice');
      for (const visual of ['video', 'image']) {
        for (const driver of ['audio', 'script']) {
          for (const source of ['Url', 'AssetId']) {
            const args: Record<string, unknown> = {
              [`${visual}${source}`]:
                source === 'Url'
                  ? `https://media.test/${visual}?signature=a%2Fb`
                  : `${visual}-asset`,
              ...(driver === 'script'
                ? { script: 'Hello', voiceId: 'real-voice' }
                : {
                    [`audio${source}`]:
                      source === 'Url' ? 'https://media.test/audio?signature=c%2Fd' : 'audio-asset',
                  }),
              projectName: 'Explicit project',
            };
            const result = await client.callTool({
              name: 'lipsync_create',
              arguments: { ...args, projectIntent: 'explicit' },
            });
            expect(result.isError).not.toBe(true);
            const posts = calls.filter((call) => call.path === '/v2/generate');
            const body = posts.at(-1)!.body;
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
              name: 'generations_get',
              arguments: { id: 'generation', wait: true, timeout: 55 },
            });
            // The API's name and the deprecated alias carry the same signed URL.
            expect(poll.structuredContent).toMatchObject({
              outputMediaUrl: signedUrl,
              outputUrl: signedUrl,
            });
            const text = JSON.parse((poll.content as Array<{ text: string }>)[0]!.text);
            expect(text.outputMediaUrl).toBe(signedUrl);
            expect(text.outputUrl).toBe(signedUrl);
          }
        }
      }
      expect(calls.filter((call) => call.path === '/v2/generate')).toHaveLength(8);
    },
  );

  it.each(['api-key', 'device-bearer'])(
    'keeps %s stdio authentication local without contaminating an HTTP session',
    async (authentication) => {
      const calls = fakeApi();
      vi.spyOn(tokenStore, 'loadToken').mockResolvedValue('fake-device-token');
      const stdio = await createSyncMcpServer({
        ...config,
        transport: 'stdio',
        apiKey: authentication === 'api-key' ? 'fake-key' : undefined,
      });
      const { client: stdioClient } = await connect(
        { createServer: () => stdio, toolCount: 5 },
        'claude',
      );
      const { client: httpClient } = await connect(await createMcpServerFactory(config), 'unknown');
      await stdioClient.callTool({
        name: 'lipsync_create',
        arguments: { videoAssetId: 'video', audioAssetId: 'audio' },
      });
      await runWithAuth('http-token', undefined, () =>
        httpClient.callTool({
          name: 'lipsync_create',
          arguments: { videoAssetId: 'video', audioAssetId: 'audio' },
        }),
      );
      const posts = calls.filter((call) => call.path === '/v2/generate');
      expect(posts[0]!.body.projectId).toBe('project:Claude generations');
      expect(posts[0]!.headers).toMatchObject(
        authentication === 'api-key'
          ? { 'x-api-key': 'fake-key', 'x-sync-source': 'claude' }
          : { Authorization: 'Bearer fake-device-token', 'x-sync-source': 'mcp:claude' },
      );
      expect(posts[1]!.body.projectId).toBe('project:Sync generations');
      expect(posts[1]!.headers).toMatchObject({
        Authorization: 'Bearer http-token',
        'x-sync-source': 'mcp',
      });
    },
  );
});

it.each([0, 1, 2])(
  'reports available registered tools with %i generated hosted operations',
  async (count) => {
    const paths = Object.fromEntries(Object.entries(spec.paths).slice(0, count));
    // Excluded operations must not inflate diagnostics or client catalogs.
    const excluded = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [
        `/v2/projects/unused-${index}`,
        { get: { operationId: `Projects_unused${index}`, tags: ['projects'] } },
      ]),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...spec, paths: { ...paths, ...excluded } })),
    );
    const factory = await createMcpServerFactory(config);
    // Includes scenes_detect and stems_separate, which only accounts with their features list.
    expect(factory.toolCount).toBe(15 + count);
    const chatgpt = await connect(factory, 'chatgpt');
    const claude = await connect(factory, 'claude');
    const chatTools = currentTools((await chatgpt.client.listTools()).tools);
    const claudeTools = (await claude.client.listTools()).tools;
    // lipsync_create-timeline stays out of the ChatGPT app listing.
    expect(chatTools).toHaveLength(12 + count);
    // Widget-only tools such as assets_list-creators (member emails) stay out of model-only catalogs.
    expect(currentTools(claudeTools)).toHaveLength(9 + count);
    // The status card's app-only old name comes with generations_get, and only with it.
    const names = new Set(claudeTools.map((tool) => tool.name));
    expect(names.has('generate_get-generation')).toBe(names.has('generations_get'));
    expect(claudeTools).toHaveLength(9 + count + (names.has('generations_get') ? 1 : 0));
    expect(claudeTools.map((tool) => tool.name)).not.toContain('assets_list-creators');
    expect(chatTools.map((tool) => tool.name)).toContain('assets_list-creators');
    expect(chatTools.some((tool) => tool.name.includes('unused'))).toBe(false);
  },
);
