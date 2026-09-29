import { type EventEmitter, once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { closeFixtureServers } from './auth/fixture-cleanup.js';
import { OAUTH_PROXY_TIMEOUT_MS, startHttpServer } from './http-server.js';

let upstream: Server | undefined;
let hosted: Server | undefined;
let url: string;
const events = ['SIGINT', 'SIGTERM', 'uncaughtExceptionMonitor', 'warning', 'exit'] as const;
const emitter: EventEmitter = process;
const previous = new Map<string, ReturnType<EventEmitter['listeners']>>();
type Scenario = {
  mode: 'success' | 'error' | 'headers' | 'body';
  calls: number;
  started: boolean;
  closed: boolean;
};
const scenarios = new Map<string, Scenario>();
beforeAll(async () => {
  for (const event of events) previous.set(event, emitter.listeners(event));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const scenario = scenarios.get(new URLSearchParams(raw).get('client_id') ?? '');
    if (!scenario) {
      res.writeHead(500);
      res.end();
      return;
    }
    scenario.calls++;
    scenario.started = true;
    res.once('close', () => {
      if (!res.writableEnded) scenario.closed = true;
    });
    if (scenario.mode === 'headers') return;
    res.setHeader('Content-Type', 'application/json');
    // Even an upstream's unsafe cache policy must not reach token clients.
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (scenario.mode === 'body') {
      res.write('{"private":"fixture-secret');
      return;
    }
    res.statusCode = scenario.mode === 'error' ? 401 : 200;
    res.end(
      JSON.stringify(
        scenario.mode === 'error'
          ? { error: 'invalid_client' }
          : { access_token: 'fixture-token', token_type: 'Bearer' },
      ),
    );
  });
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
    { toolCount: 0, createServer: () => new McpServer({ name: 'auth-fixture', version: '1' }) },
    {
      baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      transport: 'http',
      port: 0,
    },
  );
  if (!hosted) throw new Error('Hosted fixture did not start');
  url = `http://127.0.0.1:${(hosted.address() as AddressInfo).port}`;
});
afterAll(async () => {
  try {
    const shutdown = emitter
      .listeners('SIGTERM')
      .filter((listener) => !previous.get('SIGTERM')?.includes(listener));
    if (hosted?.listening && shutdown.length > 0) {
      const closed = once(hosted, 'close');
      for (const listener of shutdown) listener('SIGTERM');
      await closed;
    }
  } finally {
    try {
      await closeFixtureServers(hosted, upstream);
    } finally {
      for (const event of events)
        for (const listener of emitter.listeners(event))
          if (!previous.get(event)?.includes(listener))
            emitter.removeListener(event, listener as (...args: unknown[]) => void);
      vi.restoreAllMocks();
    }
  }
});

function start(path: string, mode: Scenario['mode'], signal?: AbortSignal) {
  const id = `scenario-${scenarios.size}`;
  const scenario: Scenario = { mode, calls: 0, started: false, closed: false };
  scenarios.set(id, scenario);
  const response = fetch(url + path, {
    method: 'POST',
    signal,
    body: new URLSearchParams({
      client_id: id,
      client_secret: 'fixture-secret',
      grant_type: 'refresh_token',
      refresh_token: 'fixture-refresh',
      token: 'fixture-token',
    }),
  });
  return { scenario, response };
}
for (const path of ['/token', '/revoke']) {
  it.each([
    'success',
    'error',
  ] as const)(`${path}: forces no-store on %s without altering the response`, async (mode) => {
    const { scenario, response } = start(path, mode);
    const res = await response;
    expect(res.status).toBe(mode === 'error' ? 401 : 200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(await res.json()).toEqual(
      mode === 'error'
        ? { error: 'invalid_client' }
        : { access_token: 'fixture-token', token_type: 'Bearer' },
    );
    expect(scenario.calls).toBe(1);
  });
  it.each(['headers', 'body'] as const)(
    `${path}: bounds stalled %s and closes upstream without retries`,
    async (mode) => {
      const { scenario, response } = start(path, mode);
      const res = await response;
      expect(res.status).toBe(504);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('pragma')).toBe('no-cache');
      expect(res.headers.get('www-authenticate')).toBeNull();
      expect(await res.json()).toEqual({
        error: 'temporarily_unavailable',
        error_description: 'OAuth upstream request timed out',
      });
      await vi.waitFor(() => expect(scenario.closed).toBe(true));
      expect(scenario.calls).toBe(1);
    },
    OAUTH_PROXY_TIMEOUT_MS + 3_000,
  );
  it.each([
    'headers',
    'body',
  ] as const)(`${path}: aborts stalled %s after caller disconnect`, async (mode) => {
    const stop = new AbortController();
    const { scenario, response } = start(path, mode, stop.signal);
    const rejected = expect(response).rejects.toThrow();
    await vi.waitFor(() => expect(scenario.started).toBe(true));
    stop.abort();
    await rejected;
    await vi.waitFor(() => expect(scenario.closed).toBe(true));
    expect(scenario.calls).toBe(1);
  });
  it(`${path}: marks local credential rejections non-cacheable before forwarding`, async () => {
    const before = [...scenarios.values()].reduce((n, s) => n + s.calls, 0);
    const res = await fetch(url + path, {
      method: 'POST',
      body: new URLSearchParams({ client_id: 'missing-secret' }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    await res.text();
    expect([...scenarios.values()].reduce((n, s) => n + s.calls, 0)).toBe(before);
  });
}
