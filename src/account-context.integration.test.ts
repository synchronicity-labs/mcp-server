import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';

it('projects the authenticated account and keeps API-key identity null across the MCP boundary', async () => {
  const account = {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'member@example.test',
    name: 'Member',
  };
  const organization = { id: '00000000-0000-4000-8000-000000000002', name: 'Team', role: 'member' };
  const calls: string[] = [];
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api-json') {
      res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
      return;
    }
    calls.push(req.url!);
    if (req.url === '/v2/plans/limits') {
      res.end(JSON.stringify({ seats: 3, voiceClone: 5, privateToken: 'must-not-leak' }));
      return;
    }
    res.end(
      JSON.stringify({
        account:
          req.headers.authorization === 'Bearer api-key'
            ? null
            : req.headers.authorization === 'Bearer unnamed-user'
              ? { ...account, email: null, name: null }
              : account,
        organization:
          req.headers.authorization === 'Bearer unnamed-user'
            ? { ...organization, name: null }
            : organization,
        privateToken: 'must-not-leak',
      }),
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'http',
    port: 0,
  });
  const server = factory.createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  await client.connect(ct);
  try {
    for (const token of ['oauth-user', 'api-key', 'unnamed-user']) {
      const result = await runWithAuth(token, 'openai-mcp', () =>
        client.callTool({ name: 'get-account-context', arguments: {} }),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        account:
          token === 'api-key'
            ? null
            : token === 'unnamed-user'
              ? { ...account, email: null, name: null }
              : account,
        organization: token === 'unnamed-user' ? { ...organization, name: null } : organization,
        limits: { seats: 3, voiceClone: 5 },
      });
      expect(JSON.stringify(result)).not.toContain('must-not-leak');
    }
    expect(calls).toEqual([
      '/v2/oauth/account',
      '/v2/plans/limits',
      '/v2/oauth/account',
      '/v2/plans/limits',
      '/v2/oauth/account',
      '/v2/plans/limits',
    ]);
  } finally {
    await client.close();
    await server.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
