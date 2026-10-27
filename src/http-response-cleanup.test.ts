import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createHttpMcpTransport } from './http-server.js';

const { StreamableHTTPServerTransport: CommonJsTransport } = createRequire(import.meta.url)(
  '@modelcontextprotocol/sdk/server/streamableHttp.js',
) as { StreamableHTTPServerTransport: typeof StreamableHTTPServerTransport };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(register: (server: McpServer) => void, format: 'esm' | 'cjs') {
  const server = new McpServer({ name: 'http-cleanup-test', version: '1' });
  register(server);
  const transport =
    format === 'esm'
      ? createHttpMcpTransport({ sessionIdGenerator: randomUUID })
      : new CommonJsTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  await server.connect(transport);
  const app = express();
  app.use(express.json());
  app.all('/mcp', (req, res) => transport.handleRequest(req, res, req.body));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`;
  let sessionId: string | null = null;
  const post = (body: object, signal = AbortSignal.timeout(5000)) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  return {
    transport,
    post,
    async initialize() {
      const response = await post({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'chatgpt', version: 'http-cleanup-test' },
        },
      });
      sessionId = response.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();
      expect(response.status).toBe(200);
      await response.json();
      const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(initialized.status).toBe(202);
      await initialized.text();
    },
    async close() {
      await server.close();
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

function expectReleased(transport: Awaited<ReturnType<typeof fixture>>['transport']) {
  // Inspect retention as well as delivery: a successful response alone misses this SDK leak.
  for (const map of ['_streamMapping', '_requestToStreamMapping', '_requestResponseMap']) {
    expect(transport).toHaveProperty(`_webStandardTransport.${map}.size`, 0);
  }
}

describe.each(['esm', 'cjs'] as const)('%s HTTP response cleanup', (format) => {
  it('releases initialization, repeated large resource reads, tool results and RPC errors', async () => {
    const html = `<!doctype html>${'Sync '.repeat(300_000)}`;
    const uri = 'ui://sync/memory-test.html';
    const http = await fixture((server) => {
      server.registerResource(
        'large-ui',
        uri,
        { mimeType: 'text/html;profile=mcp-app' },
        async () => ({
          contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: html }],
        }),
      );
      server.registerTool('echo', { inputSchema: { value: z.number() } }, async ({ value }) => ({
        content: [{ type: 'text', text: String(value) }],
      }));
    }, format);
    try {
      await http.initialize();
      expectReleased(http.transport);
      for (let index = 1; index <= 20; index++) {
        const read = await http.post({
          jsonrpc: '2.0',
          id: index,
          method: 'resources/read',
          params: { uri },
        });
        expect(read.headers.get('content-type')).toContain('application/json');
        expect(await read.json()).toMatchObject({
          id: index,
          result: { contents: [{ text: html }] },
        });
        expectReleased(http.transport);
      }
      const call = await http.post({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'echo', arguments: { value: 42 } },
      });
      expect(await call.json()).toMatchObject({ id: 21, result: { content: [{ text: '42' }] } });
      expectReleased(http.transport);
      const missing = await http.post({
        jsonrpc: '2.0',
        id: 22,
        method: 'resources/read',
        params: { uri: 'ui://sync/missing.html' },
      });
      expect(await missing.json()).toMatchObject({ id: 22, error: { code: -32602 } });
      expectReleased(http.transport);
    } finally {
      await http.close();
    }
  });

  it('releases only the completed response while another request is in flight', async () => {
    const gates = [deferred(), deferred()];
    const started = [deferred(), deferred()];
    const http = await fixture((server) => {
      server.registerTool(
        'wait',
        { inputSchema: { slot: z.number().int().min(0).max(1) } },
        async ({ slot }) => {
          started[slot]!.resolve();
          await gates[slot]!.promise;
          return { content: [{ type: 'text', text: String(slot) }] };
        },
      );
    }, format);
    const calls: Promise<unknown>[] = [];
    try {
      await http.initialize();
      for (const slot of [0, 1]) {
        calls.push(
          http
            .post({
              jsonrpc: '2.0',
              id: slot + 1,
              method: 'tools/call',
              params: { name: 'wait', arguments: { slot } },
            })
            .then((response) => response.json()),
        );
      }
      await Promise.all(started.map((gate) => gate.promise));
      expect(http.transport).toHaveProperty('_webStandardTransport._streamMapping.size', 2);
      gates[1]!.resolve();
      expect(await calls[1]).toMatchObject({ id: 2, result: { content: [{ text: '1' }] } });
      expect(http.transport).toHaveProperty('_webStandardTransport._streamMapping.size', 1);
      gates[0]!.resolve();
      expect(await calls[0]).toMatchObject({ id: 1, result: { content: [{ text: '0' }] } });
      expectReleased(http.transport);
    } finally {
      for (const gate of gates) gate.resolve();
      await Promise.allSettled(calls);
      await http.close();
    }
  });

  it('releases a completed response after disconnect without cancelling or replaying the tool', async () => {
    const started = deferred();
    const release = deferred();
    const disconnect = new AbortController();
    let executions = 0;
    let toolSignal: AbortSignal | undefined;
    const http = await fixture((server) => {
      server.registerTool('wait', { inputSchema: {} }, async (_args, extra) => {
        executions++;
        toolSignal = extra.signal;
        started.resolve();
        await release.promise;
        return { content: [{ type: 'text', text: 'completed' }] };
      });
    }, format);
    try {
      await http.initialize();
      const call = http
        .post(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'wait', arguments: {} },
          },
          disconnect.signal,
        )
        .catch(() => undefined);
      await started.promise;
      disconnect.abort();
      await call;
      expect(toolSignal?.aborted).toBe(false);
      release.resolve();
      await vi.waitFor(() => expectReleased(http.transport));
      const list = await http.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(await list.json()).toMatchObject({ id: 2, result: { tools: [{ name: 'wait' }] } });
      expect(executions).toBe(1);
      expectReleased(http.transport);
    } finally {
      disconnect.abort();
      release.resolve();
      await http.close();
    }
  });
});
