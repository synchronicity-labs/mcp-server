import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { SyncMcpConfig } from './config.js';
import { createMcpServerFactory } from './server.js';

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
    },
  } satisfies SyncMcpConfig;
}

it('opens a verified release through the real MCP tool and resource protocol', async () => {
  const factory = await createMcpServerFactory(await releaseConfig());
  const server = factory.createServer();
  const client = new Client({ name: 'chatgpt', version: 'fixture' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'open-sync-app');
    expect(tool?._meta).toMatchObject({
      ui: { resourceUri: `ui://sync/app-${digest}.html` },
      'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
    });
    expect(await client.callTool({ name: 'open-sync-app', arguments: {} })).toMatchObject({
      structuredContent: { opened: true },
    });
    const resource = await client.readResource({ uri: `ui://sync/app-${digest}.html` });
    expect(resource.contents).toEqual([
      expect.objectContaining({
        text: html,
        mimeType: 'text/html;profile=mcp-app',
        _meta: {
          ui: {
            domain: 'https://sync.fixture.invalid',
            prefersBorder: true,
            csp: { connectDomains: [], resourceDomains: ['https://media.fixture.invalid'] },
          },
        },
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

it('keeps the new app unavailable to clients without the ChatGPT UI profile', async () => {
  const factory = await createMcpServerFactory(await releaseConfig());
  const server = factory.createServer();
  const client = new Client({ name: 'claude', version: 'fixture' });
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
