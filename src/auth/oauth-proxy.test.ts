import { type EventEmitter, once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startHttpServer } from '../http-server.js';
import { closeFixtureServers } from './fixture-cleanup.js';

let upstream: Server | undefined;
let hosted: Server | undefined;
let url: string;
let upstreamStatus = 200;
let upstreamBody: string | undefined;
let dropUpstreamResponse = false;
let userinfoStatus = 200;
const calls: Array<{ path: string; body: URLSearchParams; authorization: string | undefined }> = [];
const logs: string[] = [];
const events = ['SIGINT', 'SIGTERM', 'uncaughtExceptionMonitor', 'warning', 'exit'] as const;
const emitter: EventEmitter = process;
const previous = new Map<string, ReturnType<EventEmitter['listeners']>>();

beforeAll(async () => {
  for (const event of events) previous.set(event, emitter.listeners(event));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    logs.push(String(chunk));
    return true;
  });
  upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({
      path: req.url ?? '',
      body: new URLSearchParams(body),
      authorization: req.headers.authorization,
    });
    if (dropUpstreamResponse) {
      res.destroy();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v2/oauth/userinfo') {
      res.statusCode = userinfoStatus;
      res.setHeader('Retry-After', '9');
      res.end(JSON.stringify({ sub: 'fake-user', client_id: 'client', expires_at: 4000000000 }));
      return;
    }
    if (req.url?.startsWith('/v2/oauth/register/')) {
      res.end(
        JSON.stringify({
          client_id: 'client',
          redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        }),
      );
      return;
    }
    res.statusCode = upstreamStatus;
    res.end(
      upstreamBody ??
        (upstreamStatus === 401
          ? JSON.stringify({ error: 'invalid_client' })
          : JSON.stringify({ access_token: 'fake-access-token', token_type: 'Bearer' })),
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
const basic = (value = 'client:fake-secret') => `Basic ${Buffer.from(value).toString('base64')}`;
async function post(path: string, body: string, authorization?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (authorization !== undefined) headers.Authorization = authorization;
  return fetch(url + path, { method: 'POST', headers, body });
}
const failures = [
  {
    name: 'mixed matching',
    body: 'client_id=client&client_secret=fake-secret',
    header: basic(),
    status: 400,
    error: 'invalid_request',
  },
  {
    name: 'mixed conflicting',
    body: 'client_id=other',
    header: basic(),
    status: 400,
    error: 'invalid_request',
  },
  {
    name: 'mixed empty body field',
    body: 'client_secret=',
    header: basic(),
    status: 400,
    error: 'invalid_request',
  },
  { name: 'malformed Basic', body: '', header: 'Basic ***', status: 401, error: 'invalid_client' },
  { name: 'empty Basic', body: '', header: 'Basic', status: 401, error: 'invalid_client' },
  {
    name: 'empty Basic secret',
    body: '',
    header: basic('client:'),
    status: 401,
    error: 'invalid_client',
  },
  {
    name: 'unsupported Bearer',
    body: '',
    header: 'Bearer fake-secret',
    status: 401,
    error: 'invalid_client',
  },
  { name: 'no credentials', body: '', header: undefined, status: 400, error: 'invalid_client' },
  {
    name: 'missing secret',
    body: 'client_id=client',
    header: undefined,
    status: 400,
    error: 'invalid_client',
  },
  {
    name: 'empty secret',
    body: 'client_id=client&client_secret=',
    header: undefined,
    status: 400,
    error: 'invalid_client',
  },
  {
    name: 'empty id',
    body: 'client_id=&client_secret=fake-secret',
    header: undefined,
    status: 400,
    error: 'invalid_client',
  },
  {
    name: 'duplicate id',
    body: 'client_id=client&client_id=client&client_secret=fake-secret',
    header: undefined,
    status: 400,
    error: 'invalid_request',
  },
  {
    name: 'duplicate secret',
    body: 'client_id=client&client_secret=fake-secret&client_secret=fake-secret',
    header: undefined,
    status: 400,
    error: 'invalid_request',
  },
  {
    name: 'duplicate grant type',
    body: 'client_id=client&client_secret=fake-secret&grant_type=x&grant_type=y',
    header: undefined,
    status: 400,
    error: 'invalid_request',
  },
  {
    name: 'client assertion',
    body: 'client_id=client&client_secret=fake-secret&client_assertion=x',
    header: undefined,
    status: 400,
    error: 'invalid_request',
  },
];
for (const path of ['/token', '/revoke']) {
  it.each(failures)(`${path}: rejects $name before forwarding`, async ({
    body,
    header,
    status,
    error,
  }) => {
    const before = calls.length;
    const res = await post(path, body, header);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error });
    expect(res.headers.get('www-authenticate')).toBe(status === 401 ? 'Basic realm="oauth"' : null);
    expect(calls.length).toBe(before);
  });
  it.each([
    'post',
    'basic',
  ])(`${path}: preserves %s credentials without a warm registration cache`, async (method) => {
    const before = calls.length;
    const credentials = method === 'post' ? '&client_id=client&client_secret=fake-secret' : '';
    const res = await post(
      path,
      `grant_type=authorization_code&code=fake-code&code_verifier=fake-verifier&token=fake-token${credentials}`,
      method === 'basic' ? basic() : undefined,
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBe(before + 1);
    const sent = calls.at(-1);
    expect(sent?.path).toBe(`/v2/oauth${path}`);
    expect(sent?.body.get('client_id')).toBe('client');
    expect(sent?.body.get('client_secret')).toBe('fake-secret');
    expect(sent?.body.get('code_verifier')).toBe('fake-verifier');
    expect(sent?.authorization).toBeUndefined();
  });
  it(`${path}: includes Basic challenge for backend authentication rejection`, async () => {
    upstreamStatus = 401;
    try {
      const res = await post(path, 'token=fake-token', basic());
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Basic realm="oauth"');
      expect(await res.json()).toMatchObject({ error: 'invalid_client' });
    } finally {
      upstreamStatus = 200;
    }
  });
}
it('advertises only the two supported confidential methods', async () => {
  const metadata = await (await fetch(`${url}/.well-known/oauth-authorization-server`)).json();
  expect(metadata).toMatchObject({
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
  });
});
it('does not log incoming secrets, tokens, or authorization codes', () => {
  const all = logs.join('');
  for (const value of ['fake-secret', 'fake-token', 'fake-code', 'fake-verifier', basic()])
    expect(all).not.toContain(value);
});
it('correlates a rejected scanner refresh without changing the response or logging secrets', async () => {
  const before = logs.length;
  upstreamStatus = 400;
  upstreamBody = JSON.stringify({
    statusCode: 400,
    message: 'Invalid, revoked, or expired refresh token',
    error: 'Bad Request',
    error_description: 'secret-upstream-echo',
  });
  try {
    const response = await fetch(`${url}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-request-id': 'wfr_scan-test',
      },
      body: 'grant_type=refresh_token&refresh_token=secret-refresh-test&client_id=secret-client-test&client_secret=secret-client-secret-test',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(upstreamBody);
    const logged = logs.slice(before).join('');
    expect(logged).toContain('"event":"oauth_exchange_rejected"');
    expect(logged).toContain('"requestId":"wfr_scan-test"');
    expect(logged).toContain('"source":"upstream"');
    expect(logged).toContain('"grantType":"refresh_token"');
    expect(logged).toContain('"reason":"refresh_token_invalid_revoked_or_expired"');
    for (const secret of [
      'secret-upstream-echo',
      'secret-refresh-test',
      'secret-client-test',
      'secret-client-secret-test',
    ])
      expect(logged).not.toContain(secret);
  } finally {
    upstreamStatus = 200;
    upstreamBody = undefined;
  }
});
it('distinguishes local credential rejection and does not echo an unrecognized grant', async () => {
  const before = logs.length;
  const response = await post('/token', 'grant_type=secret-grant-test');
  expect(response.status).toBe(400);
  await response.text();
  const logged = logs.slice(before).join('');
  expect(logged).toContain('"source":"local"');
  expect(logged).toContain('"oauthError":"invalid_client"');
  expect(logged).toContain('"reason":"invalid_client_authentication"');
  expect(logged).toContain('"grantType":"other"');
  expect(logged).not.toContain('secret-grant-test');
});
it('records the grant and source when the upstream connection fails', async () => {
  const before = logs.length;
  dropUpstreamResponse = true;
  try {
    const response = await post(
      '/token',
      'grant_type=refresh_token&refresh_token=secret-network-token',
      basic(),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'OAuth upstream request failed' });
    const logged = logs.slice(before).join('');
    expect(logged).toContain('"event":"oauth_exchange_rejected"');
    expect(logged).toContain('"source":"transport"');
    expect(logged).toContain('"grantType":"refresh_token"');
    expect(logged).not.toContain('secret-network-token');
    expect(logged).not.toContain('fake-secret');
  } finally {
    dropUpstreamResponse = false;
  }
});
it('rejects duplicate Authorization headers before Node can silently select one', async () => {
  const before = calls.length;
  const result = await new Promise<{ status: number | undefined; body: string }>(
    (resolve, reject) => {
      const req = request(
        `${url}/token`,
        {
          method: 'POST',
          headers: {
            Authorization: [basic(), basic('other:secret')],
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', reject);
      req.end('grant_type=refresh_token&refresh_token=fake-token');
    },
  );
  expect(result.status).toBe(400);
  expect(JSON.parse(result.body)).toMatchObject({ error: 'invalid_request' });
  expect(calls.length).toBe(before);
});
it.each(['post', 'basic'])('preserves refresh-token credentials for %s clients', async (method) => {
  const response = await post(
    '/token',
    'grant_type=refresh_token&refresh_token=fake-refresh' +
      (method === 'post' ? '&client_id=client&client_secret=fake-secret' : ''),
    method === 'basic' ? basic() : undefined,
  );
  expect(response.status).toBe(200);
  expect(calls.at(-1)?.body.get('refresh_token')).toBe('fake-refresh');
  expect(calls.at(-1)?.body.get('client_secret')).toBe('fake-secret');
});
it.each([
  200, 401, 403, 429, 503,
])('combined actual /mcp route preserves userinfo %s semantics', async (status) => {
  // Each scenario starts after explicit revocation, outside the success cache.
  expect(
    (await post('/revoke', 'token=fake-token&client_id=client&client_secret=fake-secret')).status,
  ).toBe(200);
  userinfoStatus = status;
  try {
    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer fake-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'auth-fixture', version: '1' },
        },
      }),
    });
    expect(response.status).toBe(status === 403 ? 401 : status);
    if (status === 429 || status === 503) {
      expect(response.headers.get('retry-after')).toBe('9');
      expect(response.headers.get('www-authenticate')).toBeNull();
      expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
    } else {
      await response.text();
    }
  } finally {
    userinfoStatus = 200;
  }
});
