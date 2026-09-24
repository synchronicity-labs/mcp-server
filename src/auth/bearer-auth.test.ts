import { once } from 'node:events';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { requireBearerAuth } from './bearer-auth.js';
import { createOAuthProvider } from './oauth-provider.js';
import { parseRetryAfter, verifySyncAccessToken } from './token-verification.js';

const nativeFetch = globalThis.fetch;
afterEach(() => vi.unstubAllGlobals());
async function withProtectedRoute(run: (url: string, reached: () => number) => Promise<void>) {
  const app = express();
  let reached = 0;
  app.use(
    requireBearerAuth({
      verifier: createOAuthProvider('https://fixture.invalid'),
      resourceMetadataUrl: 'https://mcp.example/metadata',
    }),
  );
  app.get('/', (_req, res) => {
    reached++;
    res.json({ ok: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => reached);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
it.each([
  200, 401, 403, 429, 500, 503, 404,
])('translates upstream %s through real HTTP middleware', async (status) => {
  const mock = vi.fn(async () =>
    Response.json(
      { sub: 'user', client_id: 'client', expires_at: 4000000000 },
      { status, headers: { 'Retry-After': '17' } },
    ),
  );
  vi.stubGlobal('fetch', mock);
  await withProtectedRoute(async (url, reached) => {
    const res = await nativeFetch(url, { headers: { Authorization: 'Bearer fake-token' } });
    expect(res.status).toBe(
      status === 200
        ? 200
        : status === 401 || status === 403
          ? 401
          : status === 429
            ? 429
            : status >= 500
              ? 503
              : 502,
    );
    expect(reached()).toBe(status === 200 ? 1 : 0);
    if (status === 401 || status === 403)
      expect(res.headers.get('www-authenticate')).toContain(
        'resource_metadata="https://mcp.example/metadata"',
      );
    else if (status !== 200) {
      expect(res.headers.get('www-authenticate')).toBeNull();
      expect(res.headers.get('retry-after')).toBe('17');
      expect(await res.json()).toMatchObject({ error: 'temporarily_unavailable' });
    }
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
it('preserves missing-token and expired-token SDK challenges', async () => {
  const mock = vi.fn(async () =>
    Response.json({ sub: 'user', client_id: 'client', expires_at: 1 }),
  );
  vi.stubGlobal('fetch', mock);
  await withProtectedRoute(async (url, reached) => {
    expect((await nativeFetch(url)).status).toBe(401);
    expect(mock).not.toHaveBeenCalled();
    expect((await nativeFetch(url, { headers: { Authorization: 'Bearer expired' } })).status).toBe(
      401,
    );
    expect(reached()).toBe(0);
  });
});
it('aborts verification when the client disconnects', async () => {
  let signal: AbortSignal | undefined;
  let started: () => void = () => {};
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      signal = init.signal;
      started();
      return new Promise(() => {});
    }),
  );
  await withProtectedRoute(async (url, reached) => {
    const req = request(url, { headers: { Authorization: 'Bearer fake-token' } });
    req.on('error', () => {});
    req.end();
    await start;
    req.destroy();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(reached()).toBe(0);
  });
});
it('aborts a native HTTP partial body by the full five-second deadline', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"sub":');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const start = Date.now();
  try {
    await expect(
      verifySyncAccessToken(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        'fake-token',
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(Date.now() - start).toBeLessThan(7000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10000);
it.each(['0', '17', 'Thu, 24 Sep 2026 15:00:00 GMT'])('accepts Retry-After %s', (value) =>
  expect(parseRetryAfter(value)).toBe(value));
it.each([
  '-1',
  '1.5',
  '1e3',
  'Infinity',
  '9999999999999999999999',
  'tomorrow',
  '2026-09-24',
  '17\r\nInjected: yes',
  '',
])('drops malformed Retry-After %s', (value) => expect(parseRetryAfter(value)).toBeUndefined());
it('retains SDK scope enforcement', async () => {
  const app = express();
  app.use(
    requireBearerAuth({
      requiredScopes: ['write'],
      verifier: {
        verifyAccessToken: async () => ({
          token: 'fake',
          clientId: 'client',
          scopes: [],
          expiresAt: 4000000000,
        }),
      },
    }),
  );
  app.get('/', (_req, res) => res.sendStatus(200));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await nativeFetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      { headers: { Authorization: 'Bearer fake' } },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('insufficient_scope');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
