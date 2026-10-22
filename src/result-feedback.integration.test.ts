import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';

const id = '00000000-0000-4000-8000-000000000001';
const projectId = '00000000-0000-4000-8000-000000000002';
const calls: { token?: string; path?: string; method?: string; body?: unknown }[] = [];
const upstream = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api-json') return void res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
  calls.push({ token: req.headers.authorization, path: req.url, method: req.method });
  if (req.url === '/v2/oauth/account')
    return void res.end(
      JSON.stringify({ account: req.headers.authorization === 'Bearer api-key' ? null : { id } }),
    );
  if (req.url === `/v2/projects/${projectId}`) {
    if (req.headers.authorization === 'Bearer revoked')
      return void res.writeHead(403).end(JSON.stringify({ message: 'Access denied' }));
    return void res.end(JSON.stringify({ id: projectId }));
  }
  if (req.url?.startsWith('/v2/generations/list'))
    return void res.end(
      JSON.stringify({
        items:
          req.headers.authorization === 'Bearer foreign'
            ? []
            : [
                {
                  id,
                  projectId,
                  status:
                    req.headers.authorization === 'Bearer pending' ? 'PROCESSING' : 'COMPLETED',
                },
              ],
      }),
    );
  if (req.url === `/v2/generations/${id}/feedback`) {
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      calls.at(-1)!.body = JSON.parse(body);
    }
    return void res.end(
      JSON.stringify({
        generationId: id,
        feedbackType: 'upvote',
        tags: [],
        textFeedback: null,
        privateToken: 'must-not-leak',
      }),
    );
  }
  res.writeHead(404).end('{}');
});
let client: Client;
let server: ReturnType<Awaited<ReturnType<typeof createMcpServerFactory>>['createServer']>;
beforeAll(async () => {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'http',
    port: 0,
  });
  server = factory.createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  await client.connect(ct);
});
afterAll(async () => {
  await client?.close();
  await server?.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});
const call = (token: string, name: string, args = {}) =>
  runWithAuth(token, 'openai-mcp', () =>
    client.callTool({ name, arguments: { projectId, generationId: id, ...args } }),
  );

it('reads accessible feedback and forwards one canonical ChatGPT vote without internal fields', async () => {
  const read = await call('member', 'get-generation-feedback');
  expect(read.isError).not.toBe(true);
  expect(read.structuredContent).toEqual({
    feedback: { generationId: id, feedbackType: 'upvote', tags: [], textFeedback: null },
  });
  const before = calls.length;
  const write = await call('member', 'submit-generation-feedback', {
    feedbackType: 'upvote',
    tags: [],
    textFeedback: null,
    source: 'foreign',
    organizationId: id,
  });
  expect(write.isError).not.toBe(true);
  expect(calls.slice(before).filter((request) => request.method === 'POST')).toEqual([
    {
      token: 'Bearer member',
      method: 'POST',
      path: `/v2/generations/${id}/feedback`,
      body: { feedbackType: 'upvote', tags: [], textFeedback: null, source: 'chatgpt' },
    },
  ]);
  expect(JSON.stringify(write)).not.toContain('must-not-leak');
});
it.each([
  'api-key',
  'revoked',
  'foreign',
  'pending',
])('refuses %s feedback before reading or writing a feedback row', async (token) => {
  const before = calls.length;
  expect((await call(token, 'get-generation-feedback')).isError).toBe(true);
  expect(
    (await call(token, 'submit-generation-feedback', { feedbackType: 'upvote' })).isError,
  ).toBe(true);
  expect(calls.slice(before).some((request) => request.path?.endsWith('/feedback'))).toBe(false);
});
