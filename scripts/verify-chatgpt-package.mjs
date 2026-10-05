import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Also runs via stdin inside the final production image, without network or credentials.
const { createMcpServerFactory } = await import(pathToFileURL(resolve('dist/server.js')));
const root = resolve(process.argv[2] ?? 'chatgpt-dist');
const { current, previous } = JSON.parse(await readFile(resolve(root, 'releases.json'), 'utf8'));
const releases = [current, ...previous];
assert(releases.length > 0 && releases.length <= 9);
globalThis.fetch = async () => Response.json({ openapi: '3.0.0', paths: {} });
const { resolveConfig } = await import(pathToFileURL(resolve('dist/config.js')));
if (process.argv.includes('--require-image-config')) {
  assert.equal(process.env.SYNC_CHATGPT_APP_RELEASES, resolve(root, 'releases.json'));
}
// Exercise production configuration, including migration from the old Porter pin.
process.env.SYNC_CHATGPT_APP_RELEASES ??= resolve(root, 'releases.json');
process.env.SYNC_CHATGPT_APP_DOMAIN = 'https://packaging.fixture.invalid';
process.env.SYNC_CHATGPT_APP_DIR = resolve(root, previous[0] ?? current);
process.env.SYNC_CHATGPT_APP_PREVIOUS_DIRS = '[]';
const factory = await createMcpServerFactory(
  resolveConfig({
    baseUrl: 'https://api.fixture.invalid',
    transport: 'http',
    port: 0,
  }),
);
const server = factory.createServer();
const client = new Client({ name: 'chatgpt', version: 'package-verification' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  const tool = (await client.listTools()).tools.find((entry) => entry.name === 'open-sync-app');
  assert.equal(tool?._meta?.ui?.resourceUri, `ui://sync/app-${releases[0]}.html`);
  const opened = await client.callTool({ name: 'open-sync-app', arguments: {} });
  assert.equal(opened.isError, undefined);
  assert.deepEqual(opened.structuredContent, { requested: true, renderStatus: 'awaiting_client' });
  for (const digest of releases) {
    const release = JSON.parse(await readFile(resolve(root, digest, 'release.json'), 'utf8'));
    const { contents } = await client.readResource({ uri: `ui://sync/app-${digest}.html` });
    assert.equal(contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.equal(createHash('sha256').update(contents[0].text).digest('hex'), digest);
    assert.equal(release.htmlSha256, digest);
    assert.equal(Buffer.byteLength(contents[0].text), release.htmlBytes);
    assert.deepEqual(contents[0]._meta.ui.permissions, { camera: {}, microphone: {} });
    assert(contents[0]._meta.ui.csp.resourceDomains.includes('blob:'));
    console.log(`MCP served verified frontend ${release.commit}: ${digest}`);
  }
} finally {
  await client.close();
  await server.close();
}
