import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createHttpClient } from './http-client.js';
import { parseSpec } from './openapi/parser.js';
import { createMcpServerFactory } from './server.js';
import { projectId, translationInput, translationSpec } from './test-fixtures/translation.js';
import { createTranslationTools } from './tools/translation.js';

const upstreams: Server[] = [];
const clients: Client[] = [];
const servers: McpServer[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const upstream of upstreams.splice(0)) {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

async function fixture() {
  const calls: Array<{
    path: string;
    token?: string;
    source?: string;
    key?: string;
    body: unknown;
  }> = [];
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api-json') {
      res.end(JSON.stringify(translationSpec));
      return;
    }
    let data = '';
    for await (const chunk of req) data += chunk.toString();
    calls.push({
      path: req.url!,
      token: req.headers.authorization,
      source: req.headers['x-sync-source'] as string | undefined,
      key: req.headers['idempotency-key'] as string | undefined,
      body: data ? JSON.parse(data) : undefined,
    });
    if (req.headers.authorization === 'Bearer denied') {
      res.statusCode = 403;
      res.end(JSON.stringify({ message: 'Not allowed' }));
    } else if (req.url === `/v2/projects/${projectId}`) {
      res.end(JSON.stringify({ id: projectId }));
    } else if (req.url === '/v2/generate') {
      res.end(
        JSON.stringify({
          id: '00000000-0000-4000-8000-000000000003',
          status: 'PENDING',
          input: 'private-input-must-not-leak',
        }),
      );
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  upstreams.push(upstream);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  return { calls, baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` };
}

it('discovers the canonical language enum and submits through the hosted MCP boundary', async () => {
  const { calls, baseUrl } = await fixture();
  const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
  const server = factory.createServer();
  servers.push(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  clients.push(client);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  expect(tools).toHaveLength(factory.toolCount);
  expect(tools.some((tool) => tool.name === 'generate_create-generation')).toBe(false);
  const tool = tools.find((tool) => tool.name === 'create-translate-and-dub')!;
  expect(tool.inputSchema.properties?.targetLang).toMatchObject({ enum: ['es', 'fr', 'ja'] });
  expect(tool.inputSchema.required).toContain('idempotencyKey');
  expect(tool._meta?.['openai/widgetAccessible']).toBe(true);
  expect(tool._meta?.securitySchemes).toEqual([{ type: 'oauth2', scopes: [] }]);
  const invalid = await client.callTool({
    name: tool.name,
    arguments: { ...translationInput, targetLang: 'invalid' },
  });
  expect(invalid.isError).toBe(true);
  expect(calls).toEqual([]);
  const result = await client.callTool({ name: tool.name, arguments: translationInput });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({
    id: '00000000-0000-4000-8000-000000000003',
    status: 'PENDING',
  });
  expect(JSON.stringify(result)).not.toContain('private-input-must-not-leak');
  expect(calls.map((call) => call.path)).toEqual([`/v2/projects/${projectId}`, '/v2/generate']);
  expect(calls[1]).toMatchObject({
    key: translationInput.idempotencyKey,
    body: {
      dubParams: { sourceLang: 'auto', targetLang: 'es' },
      input: [{ type: 'video', assetId: translationInput.videoAssetId }],
    },
  });
});

it('isolates concurrent OAuth callers and stops a denied caller before generation', async () => {
  const { calls, baseUrl } = await fixture();
  const tool = createTranslationTools(parseSpec(translationSpec), createHttpClient(baseUrl))[0]!;
  const outcomes = await Promise.allSettled(
    ['first-user', 'second-user', 'denied'].map((token) =>
      runWithAuth(token, 'openai-mcp', () =>
        tool.handler({ ...translationInput, idempotencyKey: token }),
      ),
    ),
  );
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
  const submissions = calls.filter((call) => call.path === '/v2/generate');
  expect(submissions).toHaveLength(2);
  for (const call of submissions) {
    expect(call.token).toBe(`Bearer ${call.key}`);
    expect(call.source).toBe('mcp:openai-mcp');
  }
  expect(calls.filter((call) => call.token === 'Bearer denied').map((call) => call.path)).toEqual([
    `/v2/projects/${projectId}`,
  ]);
});
