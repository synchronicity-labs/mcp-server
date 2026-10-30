import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/server';
import express from 'express';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { HttpSession } from './http-session.js';

it('releases every SDK graph and isolates request-zero cancellation between tabs', async () => {
  let created = 0;
  let closed = 0;
  const started = new Set<number>();
  const cancelled = new Set<number>();
  const finish = new Map<number, () => void>();
  const names: Array<string | undefined> = [];
  const factory = (clientName?: string) => {
    names.push(clientName);
    created++;
    const server = new McpServer({ name: 'request-scope-fixture', version: '1' });
    const close = server.close.bind(server);
    let counted = false;
    server.close = async () => {
      if (!counted) {
        counted = true;
        closed++;
      }
      await close();
    };
    server.registerTool(
      'hold',
      { inputSchema: z.object({ slot: z.number() }) },
      async ({ slot }, context) => {
        started.add(slot);
        await new Promise<void>((resolve) => {
          finish.set(slot, resolve);
          context.mcpReq.signal.addEventListener(
            'abort',
            () => {
              cancelled.add(slot);
              resolve();
            },
            { once: true },
          );
        });
        return { content: [{ type: 'text', text: String(slot) }] };
      },
    );
    return server;
  };
  const errors: Record<string, unknown>[] = [];
  const tabs = [
    new HttpSession(
      'chatgpt',
      factory,
      () => {},
      (event) => errors.push(event),
    ),
    new HttpSession('chatgpt', factory, () => {}),
  ];
  const app = express();
  app.use(express.json());
  app.post('/:tab', async (req, res) => {
    await tabs[Number(req.params.tab)]!.handleRequest(req, res, req.body.method === 'initialize');
  });
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const post = (tab: number, body: object, signal = AbortSignal.timeout(5000)) =>
    fetch(`${url}/${tab}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-03-26',
      },
      body: JSON.stringify(Array.isArray(body) ? body : { jsonrpc: '2.0', ...body }),
      signal,
    });
  const stops = [new AbortController(), new AbortController()];
  try {
    for (const tab of [0, 1]) {
      await (
        await post(tab, {
          id: 1,
          method: 'initialize',
          params: {
            clientInfo: { name: 'chatgpt', version: '1' },
            capabilities: {},
            protocolVersion: '2025-03-26',
          },
        })
      ).text();
      expect(closed).toBe(created);
      await (await post(tab, { method: 'notifications/initialized' })).text();
      for (let i = 0; i < 10; i++) {
        const response = await post(tab, { id: i, method: 'tools/list' });
        expect(await response.text()).toContain('hold');
        expect(closed).toBe(created);
      }
    }
    expect(names.filter((name) => name === 'chatgpt')).toHaveLength(20);
    const invalid = await post(0, { id: 55, method: 'unknown/private-value' });
    await invalid.text();
    expect(errors).toEqual([{ requestId: undefined, category: 'protocol', code: -32601 }]);
    const batch = [0, 2].map((slot) => ({
      jsonrpc: '2.0',
      id: slot,
      method: 'tools/call',
      params: { name: 'hold', arguments: { slot } },
    }));
    const pending = [
      post(0, batch, stops[0]!.signal)
        .then((r) => r.text())
        .catch(() => undefined),
      post(
        1,
        { id: 0, method: 'tools/call', params: { name: 'hold', arguments: { slot: 1 } } },
        stops[1]!.signal,
      )
        .then((r) => r.text())
        .catch(() => undefined),
    ];
    await expect.poll(() => started.size).toBe(3);
    const duplicate = await post(0, { id: 0, method: 'tools/list' });
    expect(duplicate.status).toBe(400);
    await duplicate.text();
    const response = await post(0, { method: 'notifications/cancelled', params: { requestId: 0 } });
    expect(response.status).toBe(202);
    await response.text();
    expect(cancelled.has(0)).toBe(true);
    expect(cancelled.has(1)).toBe(false);
    expect(cancelled.has(2)).toBe(false);
    finish.get(2)?.();
    finish.get(1)?.();
    const [batchResult] = await Promise.all(pending);
    expect(JSON.parse(batchResult!)).toEqual(
      expect.arrayContaining([
        { jsonrpc: '2.0', id: 0, error: { code: -32800, message: 'Request cancelled' } },
        { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '2' }] } },
      ]),
    );
    await expect.poll(() => closed).toBe(created);
    // A client need not abort its original HTTP request after cancelling or DELETE.
    for (const [slot, action] of [
      [3, 'cancel'],
      [4, 'disconnect'],
      [5, 'delete'],
    ] as const) {
      let settled = false;
      const disconnect = new AbortController();
      const request = post(
        1,
        {
          id: slot,
          method: 'tools/call',
          params: { name: 'hold', arguments: { slot } },
        },
        AbortSignal.any([disconnect.signal, AbortSignal.timeout(5000)]),
      )
        .catch(() => undefined)
        .finally(() => {
          settled = true;
        });
      await expect.poll(() => started.has(slot)).toBe(true);
      if (action === 'cancel') {
        const cancellation = await post(1, {
          method: 'notifications/cancelled',
          params: { requestId: slot },
        });
        expect(cancellation.status).toBe(202);
        await cancellation.text();
      } else if (action === 'disconnect') disconnect.abort();
      else await tabs[1]!.close();
      await expect.poll(() => settled, { timeout: 1000 }).toBe(true);
      await request;
      expect(cancelled.has(slot)).toBe(true);
    }
  } finally {
    for (const stop of stops) stop.abort();
    for (const resolve of finish.values()) resolve();
    await Promise.all(tabs.map((tab) => tab.close()));
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});
