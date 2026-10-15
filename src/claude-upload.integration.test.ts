import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runWithAuth } from './auth/async-context.js';
import { claudeUploadSettings } from './claude-upload.js';
import type { SyncMcpConfig } from './config.js';
import { createMcpServerFactory } from './server.js';

const directories: string[] = [];
const html = '<!doctype html><title>Sync branded uploader</title>';
const digest = createHash('sha256').update(html).digest('hex');
const mcpUrl = 'https://sync.fixture.invalid/mcp';
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sync-claude-upload-'));
  directories.push(directory);
  await writeFile(join(directory, 'app.html'), html);
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({ version: 1, file: 'app.html', sha256: digest }),
  );
  const bearerTokens: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api-json'))
      return Response.json({
        openapi: '3.0.0',
        paths: {
          '/v2/assets/upload': {
            post: {
              operationId: 'Assets_createUploadUrl',
              tags: ['Assets'],
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        size: { type: 'number' },
                        contentType: { type: 'string' },
                        fileName: { type: 'string' },
                      },
                      required: ['size', 'contentType', 'fileName'],
                    },
                  },
                },
              },
            },
          },
        },
      });
    bearerTokens.push(new Headers(init?.headers).get('authorization') ?? '');
    return Response.json({
      uploadUrl: 'https://storage.fixture.invalid/object?signature=private',
      url: 'https://cdn.fixture.invalid/object',
      expiresIn: 900,
    });
  });
  const config: SyncMcpConfig = {
    baseUrl: 'https://api.fixture.invalid',
    transport: 'http',
    port: 0,
    claudeUpload: { directory, mcpUrl, storageOrigin: 'https://storage.fixture.invalid' },
  };
  const factory = await createMcpServerFactory(config);
  return { factory, bearerTokens };
}

it('exposes only the standalone upload card to Claude, retaining other hosts and the attachment guard', async () => {
  const { factory } = await fixture();
  for (const name of [
    'claude',
    'claude-ai',
    'Anthropic/ClaudeAI',
    'Anthropic/Toolbox',
    'chatgpt',
    'unknown',
  ]) {
    const server = factory.createServer();
    const client = new Client({ name, version: 'fixture' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const tools = (await client.listTools()).tools;
      const claude = name.startsWith('claude') || name.startsWith('Anthropic/');
      expect(tools.some((t) => t.name === 'open-media-upload')).toBe(claude);
      const resources = (await client.listResources()).resources;
      expect(resources.some((r) => r.name === 'claude-upload')).toBe(claude);
      if (claude) {
        const tool = tools.find((t) => t.name === 'open-media-upload');
        expect(tool?._meta).toMatchObject({ ui: { resourceUri: `ui://sync/app-${digest}.html` } });
        expect(JSON.stringify(tool)).not.toContain('openai/');
        expect(tools.some((t) => t.name === 'upload-media')).toBe(false);
        expect(
          (await client.callTool({ name: 'open-media-upload', arguments: {} })).structuredContent,
        ).toEqual({ requested: true, renderStatus: 'awaiting_client' });
        const result = await client.readResource({ uri: `ui://sync/app-${digest}.html` });
        expect(result.contents[0]).toMatchObject({
          text: html,
          _meta: {
            ui: {
              domain: `${createHash('sha256').update(mcpUrl).digest('hex').slice(0, 32)}.claudemcpcontent.com`,
              csp: { connectDomains: ['https://sync.fixture.invalid'], resourceDomains: ['blob:'] },
            },
          },
        });
      } else {
        expect((await client.callTool({ name: 'open-media-upload', arguments: {} })).isError).toBe(
          true,
        );
        await expect(client.readResource({ uri: `ui://sync/app-${digest}.html` })).rejects.toThrow(
          'not available',
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  }
});

it('issues bounded relay tickets only for configured Claude sessions with request-local authentication', async () => {
  const { factory, bearerTokens } = await fixture();
  for (const [name, token] of [
    ['claude', 'org-a'],
    ['chatgpt', 'org-b'],
  ] as const) {
    const server = factory.createServer();
    const client = new Client({ name, version: 'fixture' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const result = await runWithAuth(token!, name, () =>
        client.callTool({
          name: 'assets_create-upload-url',
          arguments: { fileName: 'sample.mp4', contentType: 'video/mp4', size: 32 },
        }),
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const value = z
        .object({ uploadUrl: z.string(), expiresIn: z.number() })
        .parse(result.structuredContent);
      expect(value?.uploadUrl).toMatch(
        name === 'claude'
          ? /^https:\/\/sync.fixture.invalid\/app-upload\?ticket=[a-f0-9]{64}$/
          : /^https:\/\/storage.fixture.invalid\//,
      );
      if (name === 'claude') expect(value?.expiresIn).toBe(300);
    } finally {
      await client.close();
      await server.close();
    }
  }
  expect(bearerTokens).toEqual(['Bearer org-a', 'Bearer org-b']);
});

it.each([
  'https://*.sync.so/mcp',
  'http://sync.so/mcp',
  'https://user:secret@sync.so/mcp',
  'https://sync.so/mcp?secret=x',
])('rejects invalid Claude MCP configuration %s', (mcpUrl) => {
  expect(() =>
    claudeUploadSettings({ mcpUrl, storageOrigin: 'https://storage.fixture.invalid' }),
  ).toThrow();
});
