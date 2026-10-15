import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const { createMcpServerFactory } = await import(pathToFileURL(resolve('dist/server.js')).href);
const manifest = JSON.parse(await readFile('dist/claude-upload/manifest.json', 'utf8'));
assert.equal(manifest.repository, 'synchronicity-labs/sync-api-v2');
assert.match(manifest.commit, /^[a-f0-9]{40}$/);
globalThis.fetch = async () => Response.json({ openapi: '3.0.0', paths: {} });
const factory = await createMcpServerFactory({
  transport: 'http',
  port: 0,
  baseUrl: 'https://fixture.invalid',
  claudeUpload: {
    mcpUrl: 'https://mcp.fixture.invalid/mcp',
    storageOrigin: 'https://storage.fixture.invalid',
  },
});
for (const name of ['Anthropic/ClaudeAI', 'chatgpt', 'unknown']) {
  const server = factory.createServer();
  const client = new Client({ name, version: 'package-check' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tool = (await client.listTools()).tools.find(
      (value) => value.name === 'open-media-upload',
    );
    assert.equal(Boolean(tool), name === 'Anthropic/ClaudeAI');
    if (tool) {
      const uri = `ui://sync/app-${manifest.sha256}.html`;
      assert.equal(tool._meta.ui.resourceUri, uri);
      const result = await client.readResource({ uri });
      assert.equal(
        createHash('sha256').update(result.contents[0].text).digest('hex'),
        manifest.sha256,
      );
      assert.equal(JSON.stringify(result).includes('openai/widget'), false);
    }
  } finally {
    await client.close();
    await server.close();
  }
}
console.log(`Verified standalone Claude uploader ${manifest.commit}: ${manifest.sha256}`);
