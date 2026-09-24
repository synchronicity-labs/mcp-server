import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { createHttpClient } from './http-client.js';
import { registerTools } from './server.js';
import { createAppTools } from './tools/app-tools.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('HTTP cancellation versus response disconnect', () => {
  it.each([true, false])('explicit cancellation=%s at project preflight', async (explicit) => {
    const started = deferred<void>();
    const release = deferred<void>();
    const finished = deferred<void>();
    const aborted = deferred<void>();
    let generationPosts = 0;
    const api = express();
    api.get('/v2/projects', async (_req, res) => {
      res.on('close', () => {
        if (!res.writableEnded) aborted.resolve();
      });
      started.resolve();
      await release.promise;
      res.json({ items: [{ id: 'project', name: 'ChatGPT generations' }] });
    });
    api.post('/v2/generate', (_req, res) => {
      generationPosts++;
      res.json({ id: 'generation', status: 'PENDING' });
    });
    const upstream = api.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => upstream.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const mcp = new McpServer({ name: 'test', version: '1' });
    let toolSignal: AbortSignal | undefined;
    registerTools(
      mcp,
      createAppTools(createHttpClient(baseUrl)).map((tool) => {
        if (tool.name !== 'create-lipsync' || tool.resultFormat === 'mcp') return tool;
        return {
          ...tool,
          handler: async (args, context) => {
            toolSignal = context?.signal;
            try {
              return await tool.handler(args, context);
            } finally {
              finished.resolve();
            }
          },
        };
      }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await mcp.connect(transport);
    const app = express();
    app.use(express.json());
    app.all('/mcp', async (req, res) => {
      await transport.handleRequest(req, res, req.body);
    });
    const http = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => http.once('listening', resolve));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const post = (body: unknown, signal?: AbortSignal) =>
      fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    try {
      const init = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      });
      headers['mcp-session-id'] = init.headers.get('mcp-session-id')!;
      await init.text();
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const disconnect = new AbortController();
      const call = post(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'create-lipsync',
            arguments: { videoAssetId: 'video', audioAssetId: 'audio' },
          },
        },
        disconnect.signal,
      )
        .then((response) => response.text())
        .catch(() => undefined);
      await started.promise;
      if (explicit) {
        const notification = await post({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 2, reason: 'user cancelled' },
        });
        expect(notification.status).toBe(202);
        await aborted.promise;
        expect(toolSignal?.aborted).toBe(true);
      } else {
        disconnect.abort();
        await call;
        expect(toolSignal?.aborted).toBe(false);
      }
      release.resolve();
      await finished.promise;
      expect(generationPosts).toBe(explicit ? 0 : 1);
      disconnect.abort();
      await call;
    } finally {
      release.resolve();
      await mcp.close();
      http.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => http.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ]);
    }
  });
});
