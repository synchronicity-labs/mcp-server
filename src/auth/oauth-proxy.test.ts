import { type EventEmitter, once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startHttpServer } from '../http-server.js';

let upstream: Server;
let hosted: Server;
let url: string;
let upstreamStatus = 200;
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
    res.setHeader('Content-Type', 'application/json');
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
      upstreamStatus === 401
        ? JSON.stringify({ error: 'invalid_client' })
        : JSON.stringify({ access_token: 'fake-access-token', token_type: 'Bearer' }),
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
  url = `http://127.0.0.1:${(hosted.address() as AddressInfo).port}`;
});
afterAll(async () => {
  const closed = once(hosted, 'close');
  for (const listener of emitter.listeners('SIGTERM'))
    if (!previous.get('SIGTERM')?.includes(listener)) listener('SIGTERM');
  await closed;
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  for (const event of events)
    for (const listener of emitter.listeners(event))
      if (!previous.get(event)?.includes(listener))
        emitter.removeListener(event, listener as (...args: unknown[]) => void);
  vi.restoreAllMocks();
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
