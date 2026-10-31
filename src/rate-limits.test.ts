import { type EventEmitter, once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/server';
import express from 'express';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startHttpServer } from './http-server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

const heap = vi.hoisted(() => ({ used_heap_size: 20, heap_size_limit: 100 }));
vi.mock('node:v8', () => ({ getHeapStatistics: () => heap }));

// Every request comes from 127.0.0.1, standing in for a hosted client's shared egress
// address. Userinfo and token responses are local fixtures.
let upstream: Server | undefined;
let hosted: Server | undefined;
let base: string;
const events = ['SIGINT', 'SIGTERM', 'uncaughtExceptionMonitor', 'warning', 'exit'] as const;
const emitter: EventEmitter = process;
const previous = new Map<string, ReturnType<EventEmitter['listeners']>>();

beforeAll(async () => {
  for (const event of events) previous.set(event, emitter.listeners(event));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  upstream = createServer(
    asyncRequestListener(async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
      res.setHeader('Content-Type', 'application/json');
      if (path === '/v2/oauth/userinfo') {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (token === 'rejected') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'invalid_token' }));
          return;
        }
        res.end(
          JSON.stringify({
            sub: token,
            client_id: 'client',
            organization_id: 'org',
            expires_at: 4000000000,
          }),
        );
        return;
      }
      if (path === '/v2/oauth/token') {
        let form = '';
        for await (const chunk of req) form += String(chunk);
        const params = new URLSearchParams(form);
        if (params.get('client_secret') === 'wrong') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'invalid_client' }));
          return;
        }
        const rejected = params.get('client_id')?.startsWith('rejected-');
        res.statusCode = rejected ? 400 : 200;
        res.end(JSON.stringify(rejected ? { error: 'invalid_grant' } : { access_token: 'a' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    }),
  );
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const listen = express.application.listen;
  vi.spyOn(express.application, 'listen').mockImplementation(function (
    this: express.Application,
    ...args: Parameters<typeof listen>
  ) {
    hosted = listen.apply(this, args);
    return hosted;
  });
  await startHttpServer(
    {
      toolCount: 0,
      createServer: () => new McpServer({ name: 'rate-limit-fixture', version: '1' }),
    },
    {
      baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      transport: 'http',
      port: 0,
    },
  );
  if (!hosted) throw new Error('Hosted fixture did not start');
  base = `http://127.0.0.1:${(hosted.address() as AddressInfo).port}`;
});

afterAll(async () => {
  try {
    if (hosted?.listening) {
      const closed = once(hosted, 'close');
      for (const listener of emitter.listeners('SIGTERM'))
        if (!previous.get('SIGTERM')?.includes(listener)) listener('SIGTERM');
      hosted.closeAllConnections();
      await closed;
    }
  } finally {
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    }
    for (const event of events)
      for (const listener of emitter.listeners(event))
        if (!previous.get(event)?.includes(listener))
          emitter.removeListener(event, listener as (...args: unknown[]) => void);
    vi.restoreAllMocks();
  }
});

async function mcp(token: string) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  await res.arrayBuffer();
  return res.status;
}

async function exchangeToken(clientId: string, clientSecret = 's') {
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'r',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  await res.arrayBuffer();
  return res.status;
}

async function repeat(times: number, send: () => Promise<number>) {
  const statuses: number[] = [];
  for (let index = 0; index < times; index++) statuses.push(await send());
  return statuses;
}

// The tests share one server and address, so their order is part of the scenario.
it('limits /mcp per signed-in user, so users on one address do not share a bucket', async () => {
  const first = await repeat(120, () => mcp('user-a'));
  expect(first).not.toContain(429);
  expect(await mcp('user-a')).toBe(429);
  expect(await mcp('user-b')).not.toBe(429);
});

it('counts only rejected credentials against the address on /mcp', async () => {
  // The 122 accepted and rate-limited requests above did not use this budget.
  const rejected = await repeat(300, () => mcp('rejected'));
  expect(new Set(rejected)).toEqual(new Set([401]));
  expect(await mcp('rejected')).toBe(429);
});

it('limits /token per OAuth client, so clients on one address do not share a bucket', async () => {
  const first = await repeat(120, () => exchangeToken('client-a'));
  expect(new Set(first)).toEqual(new Set([200]));
  expect(await exchangeToken('client-a')).toBe(429);
  expect(await exchangeToken('client-b')).toBe(200);
});

it('does not let wrong-secret requests spend an OAuth client allowance', async () => {
  // Client IDs are not secret, so anyone could otherwise throttle another client's refreshes.
  const wrongSecret = await repeat(150, () => exchangeToken('client-c', 'wrong'));
  expect(new Set(wrongSecret)).toEqual(new Set([401]));
  expect(await exchangeToken('client-c')).toBe(200);
});

it('counts only rejected token requests against the address', async () => {
  // The 150 wrong-secret attempts above spent half of this address's 300.
  const rejected = await repeat(150, () => exchangeToken('rejected-client'));
  expect(new Set(rejected)).toEqual(new Set([400]));
  expect(await exchangeToken('rejected-client')).toBe(429);
});
