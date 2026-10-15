import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';

it('reports the credential-bound account through Claude tools without caching another request’s identity', async () => {
  const requests: string[] = [];
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api-json') {
      res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
      return;
    }
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization === 'Bearer revoked') {
      res.statusCode = 401;
      res.end(JSON.stringify({ message: 'Account no longer has access' }));
      return;
    }
    const second = req.headers.authorization === 'Bearer second';
    res.end(
      JSON.stringify({
        account: {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'Test member',
          email: 'member@example.com',
        },
        organization: {
          id: second
            ? '00000000-0000-4000-8000-000000000003'
            : '00000000-0000-4000-8000-000000000002',
          name: second ? 'Second team' : 'First team',
          role: 'member',
        },
        privateBillingData: 'must-not-leak',
      }),
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
  const server = factory.createServer();
  const client = new Client({ name: 'claude', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(
      (await client.listTools()).tools.find((tool) => tool.name === 'get-account-context'),
    ).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false } });
    const first = await runWithAuth('first', 'claude', () =>
      client.callTool({ name: 'get-account-context', arguments: {} }),
    );
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({ organization: { name: 'First team' } });
    const second = await runWithAuth('second', 'claude', () =>
      client.callTool({ name: 'get-account-context', arguments: {} }),
    );
    expect(second.structuredContent).toMatchObject({ organization: { name: 'Second team' } });
    expect(JSON.stringify(second)).not.toContain('must-not-leak');
    const denied = await runWithAuth('revoked', 'claude', () =>
      client.callTool({ name: 'get-account-context', arguments: {} }),
    );
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({ error: { status: 401 } });
    expect(requests).toEqual(Array(3).fill('GET /v2/oauth/account'));
  } finally {
    await client.close();
    await server.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it('reports the organization without a user for a local API-key connection', async () => {
  const requests: Array<{ path?: string; key?: string | string[]; bearer?: string }> = [];
  const organization = {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'API team',
    role: 'member',
  };
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api-json') {
      res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
      return;
    }
    requests.push({
      path: req.url,
      key: req.headers['x-api-key'],
      bearer: req.headers.authorization,
    });
    if (req.headers['x-api-key'] !== 'fixture-local-key') {
      res.statusCode = 401;
      res.end('{}');
      return;
    }
    res.end(JSON.stringify({ account: null, organization }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const server = await createSyncMcpServer({
    baseUrl,
    transport: 'stdio',
    apiKey: 'fixture-local-key',
    port: 0,
  });
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: 'get-account-context', arguments: {} });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual({ account: null, organization });
    expect(requests).toEqual([
      { path: '/v2/oauth/account', key: 'fixture-local-key', bearer: undefined },
    ]);
  } finally {
    await client.close();
    await server.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
