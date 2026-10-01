import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { SyncMcpConfig } from './config.js';
import { createMcpServerFactory } from './server.js';
import { UPLOAD_WIDGET_URI } from './tools/upload-widget.js';

const html = '<!doctype html><html><body>Sync release fixture</body></html>';
const digest = createHash('sha256').update(html).digest('hex');
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function releaseConfig() {
  const directory = await mkdtemp(join(tmpdir(), 'sync-chatgpt-release-'));
  directories.push(directory);
  await writeFile(join(directory, 'app.html'), html);
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({ version: 1, file: 'app.html', sha256: digest }),
  );
  vi.stubGlobal('fetch', async () => Response.json({ openapi: '3.0.0', paths: {} }));
  return {
    baseUrl: 'https://api.fixture.invalid',
    transport: 'http',
    port: 0,
    chatgptApp: {
      directory,
      domain: 'https://sync.fixture.invalid',
      resourceDomains: ['https://media.fixture.invalid'],
      connectDomains: ['https://uploads.fixture.invalid'],
    },
  } satisfies SyncMcpConfig;
}

it.each([
  'chatgpt',
  'openai-mcp',
  'openai-mcp (Codex)',
])('opens a verified release for %s through the real MCP tool and resource protocol', async (name) => {
  const factory = await createMcpServerFactory(await releaseConfig());
  const server = factory.createServer();
  const client = new Client({ name, version: 'fixture' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    const tool = tools.find((entry) => entry.name === 'open-sync-app');
    expect((await client.listResources()).resources.map((resource) => resource.uri)).toContain(
      `ui://sync/app-${digest}.html`,
    );
    const create = tools.find((entry) => entry.name === 'create-lipsync');
    expect(create?._meta).toMatchObject({ ui: { visibility: ['model', 'app'] } });
    if (name === 'openai-mcp (Codex)') {
      expect(tools.map((entry) => entry.name)).not.toContain('upload-media');
      expect(tools.map((entry) => entry.name)).not.toContain('open-upload-widget');
      for (const field of ['video', 'image', 'audio']) {
        expect(create?.inputSchema.properties).not.toHaveProperty(field);
      }
      expect(
        (await client.listResources()).resources.map((resource) => resource.uri),
      ).not.toContain(UPLOAD_WIDGET_URI);
      expect((await client.callTool({ name: 'open-upload-widget', arguments: {} })).isError).toBe(
        true,
      );
      await expect(client.readResource({ uri: UPLOAD_WIDGET_URI })).rejects.toThrow();
      expect(
        (await client.callTool({ name: 'create-lipsync', arguments: { video: {} } })).isError,
      ).toBe(true);
    }
    expect(tool?._meta).toMatchObject({
      ui: { resourceUri: `ui://sync/app-${digest}.html` },
      'openai/outputTemplate': `ui://sync/app-${digest}.html`,
      'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
    });
    expect(await client.callTool({ name: 'open-sync-app', arguments: {} })).toMatchObject({
      structuredContent: { requested: true, renderStatus: 'awaiting_client' },
    });
    const resource = await client.readResource({ uri: `ui://sync/app-${digest}.html` });
    expect(resource.contents).toEqual([
      expect.objectContaining({
        text: html,
        mimeType: 'text/html;profile=mcp-app',
        _meta: expect.objectContaining({
          'openai/widgetCSP': {
            connect_domains: ['https://uploads.fixture.invalid'],
            resource_domains: ['https://media.fixture.invalid'],
          },
          'openai/widgetDomain': 'https://sync.fixture.invalid',
          ui: {
            domain: 'https://sync.fixture.invalid',
            prefersBorder: true,
            csp: {
              connectDomains: ['https://uploads.fixture.invalid'],
              resourceDomains: ['https://media.fixture.invalid'],
            },
          },
        }),
      }),
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

it('rejects a release whose HTML does not match its manifest', async () => {
  const config = await releaseConfig();
  await writeFile(join(config.chatgptApp.directory, 'app.html'), '<html>changed bytes</html>');
  await expect(createMcpServerFactory(config)).rejects.toThrow('SHA256');
});

it('rejects wildcard media origins before exposing the app', async () => {
  const config = await releaseConfig();
  config.chatgptApp.resourceDomains = ['https://*.fixture.invalid'];
  await expect(createMcpServerFactory(config)).rejects.toThrow('exact HTTPS origin');
});

it.each([
  'claude',
  'unknown',
  'openai-mcp (Codex).evil',
])('keeps the app unavailable for unsupported client %s', async (name) => {
  const factory = await createMcpServerFactory(await releaseConfig());
  const server = factory.createServer();
  const client = new Client({ name, version: 'fixture' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    expect((await client.listTools()).tools.map((entry) => entry.name)).not.toContain(
      'open-sync-app',
    );
    expect((await client.listResources()).resources).toEqual([]);
    expect((await client.callTool({ name: 'open-sync-app', arguments: {} })).isError).toBe(true);
    await expect(client.readResource({ uri: `ui://sync/app-${digest}.html` })).rejects.toThrow();
  } finally {
    await client.close();
    await server.close();
  }
});

it.each([
  'openai-mcp',
  'openai-mcp (Codex)',
])('serves the exact previous bundle to cached descriptors for %s', async (name) => {
  const previous = await releaseConfig();
  const current = await releaseConfig();
  const newHtml = '<html>New release</html>';
  const newDigest = createHash('sha256').update(newHtml).digest('hex');
  await writeFile(join(current.chatgptApp.directory, 'app.html'), newHtml);
  await writeFile(
    join(current.chatgptApp.directory, 'manifest.json'),
    JSON.stringify({ version: 1, file: 'app.html', sha256: newDigest }),
  );
  const factory = await createMcpServerFactory({
    ...current,
    chatgptApp: { ...current.chatgptApp, previousDirectories: [previous.chatgptApp.directory] },
  });
  const server = factory.createServer();
  const client = new Client({ name, version: 'fixture' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    // Reproduce the real client: initialize, then read a cached URI without rediscovery.
    const oldResource = await client.readResource({ uri: `ui://sync/app-${digest}.html` });
    expect(oldResource.contents[0]).toMatchObject({
      uri: `ui://sync/app-${digest}.html`,
      text: html,
    });
    const tools = await client.listTools();
    expect(tools.tools.find((t) => t.name === 'open-sync-app')?._meta?.ui).toMatchObject({
      resourceUri: `ui://sync/app-${newDigest}.html`,
    });
    expect(
      (await client.readResource({ uri: `ui://sync/app-${newDigest}.html` })).contents[0],
    ).toMatchObject({ text: newHtml });
    await expect(client.readResource({ uri: 'ui://sync/app-unknown.html' })).rejects.toThrow();
  } finally {
    await client.close();
    await server.close();
  }
});

it('rejects corrupted retained bundles rather than serving different bytes at an immutable URI', async () => {
  const previous = await releaseConfig();
  const current = await releaseConfig();
  await writeFile(join(previous.chatgptApp.directory, 'app.html'), '<html>tampered</html>');
  await expect(
    createMcpServerFactory({
      ...current,
      chatgptApp: { ...current.chatgptApp, previousDirectories: [previous.chatgptApp.directory] },
    }),
  ).rejects.toThrow('SHA256');
});
