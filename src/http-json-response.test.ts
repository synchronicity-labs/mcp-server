import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createHttpMcpTransport } from './http-server.js';

it('finishes large UI resource reads and subsequent requests as complete JSON responses', async () => {
  const html = '<!doctype html><p>' + 'Sync '.repeat(300_000) + '</p>';
  const uri = 'ui://sync/large-test.html';
  const server = new McpServer({ name: 'json-response-test', version: '1' });
  server.registerResource('large-ui', uri, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
    contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: html }],
  }));
  const transport = createHttpMcpTransport({ sessionIdGenerator: randomUUID });
  await server.connect(transport);
  const app = express();
  app.use(express.json());
  app.all('/mcp', (req, res) => transport.handleRequest(req, res, req.body));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`;
  let sessionId: string | null = null;
  const post = (body: object) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  try {
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'openai-mcp', version: 'test' },
      },
    });
    expect(init.headers.get('content-type')).toContain('application/json');
    sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    expect(z.object({ id: z.number() }).parse(await init.json()).id).toBe(1);
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const read = await post({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri } });
    expect(read.headers.get('content-type')).toContain('application/json');
    const body = z
      .object({
        id: z.number(),
        result: z.object({ contents: z.tuple([z.object({ text: z.string() })]) }),
      })
      .parse(await read.json());
    expect(body.id).toBe(2);
    expect(createHash('sha256').update(body.result.contents[0].text).digest('hex')).toBe(
      createHash('sha256').update(html).digest('hex'),
    );
    const list = await post({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    expect(
      z
        .object({ result: z.object({ resources: z.tuple([z.object({ uri: z.string() })]) }) })
        .parse(await list.json()).result.resources[0].uri,
    ).toBe(uri);
    const missing = await post({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: { uri: 'ui://sync/missing.html' },
    });
    expect(missing.headers.get('content-type')).toContain('application/json');
    expect(
      z.object({ error: z.object({ code: z.number() }) }).parse(await missing.json()).error.code,
    ).toBe(-32602);
  } finally {
    await server.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});
