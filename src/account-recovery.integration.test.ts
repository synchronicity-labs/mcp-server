import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';

it('recovers account reads through MCP without confusing expired credentials, permissions and limits outages', async () => {
  const identity = {
    account: {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'member@example.test',
      name: 'Member',
    },
    organization: { id: '00000000-0000-4000-8000-000000000002', name: 'Team', role: 'member' },
  };
  let accountStatus = 200;
  let limitsStatus = 200;
  const writes: string[] = [];
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET') writes.push(req.url ?? '');
    if (req.url === '/api-json')
      return void res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
    const status = req.url === '/v2/oauth/account' ? accountStatus : limitsStatus;
    res.statusCode = status;
    res.end(
      JSON.stringify(
        status !== 200
          ? { message: 'fixture refusal' }
          : req.url === '/v2/oauth/account'
            ? identity
            : { seats: 3, voiceClone: 5 },
      ),
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'http',
    port: 3002,
  });
  const server = factory.createServer();
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const read = () =>
    runWithAuth('fixture-token', 'openai-mcp', () =>
      client.callTool({ name: 'get-account-context', arguments: {} }),
    );
  try {
    // Preserve extension fields that the generic SDK's Tool schema strips.
    const catalog = await client.request(
      { method: 'tools/list' },
      z.object({ tools: z.array(z.looseObject({ name: z.string() })) }),
    );
    const descriptor = catalog.tools.find((tool) => tool.name === 'get-account-context');
    expect(descriptor).toMatchObject({
      securitySchemes: [{ type: 'oauth2', scopes: [] }],
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: [] }] },
    });
    for (const status of [401, 403, 503]) {
      accountStatus = status;
      const failed = await read();
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({ error: { status } });
      if (status === 401) {
        expect(failed._meta?.['mcp/www_authenticate']).toEqual([
          'Bearer resource_metadata="http://localhost:3002/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="Reconnect your Sync account to continue"',
        ]);
      } else expect(failed._meta?.['mcp/www_authenticate']).toBeUndefined();
    }
    accountStatus = 200;
    limitsStatus = 503;
    const degraded = await read();
    expect(degraded.isError).not.toBe(true);
    expect(degraded.structuredContent).toMatchObject(identity);
    expect(degraded.structuredContent).not.toHaveProperty('limits');
    limitsStatus = 401;
    expect((await read())._meta?.['mcp/www_authenticate']).toBeDefined();
    limitsStatus = 200;
    const recovered = await read();
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({
      ...identity,
      limits: { seats: 3, voiceClone: 5 },
    });
    expect(writes).toEqual([]);
  } finally {
    await client.close();
    await server.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
