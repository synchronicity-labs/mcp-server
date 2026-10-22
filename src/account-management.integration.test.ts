import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const writes: { token: string | undefined; body: unknown }[] = [];
const upstream = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api-json') {
    res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
    return;
  }
  if (req.headers.authorization === 'Bearer forbidden') {
    res.writeHead(403).end(JSON.stringify({ message: 'Access denied' }));
    return;
  }
  if (req.url === '/v2/oauth/account') {
    res.end(
      JSON.stringify({
        organization: { role: req.headers.authorization === 'Bearer admin' ? 'admin' : 'member' },
      }),
    );
    return;
  }
  if (req.url === `/v2/projects/${projectId}` && req.method === 'PATCH') {
    let body = '';
    for await (const chunk of req) body += chunk;
    writes.push({ token: req.headers.authorization, body: JSON.parse(body) });
    res.end(JSON.stringify({ id: projectId, name: JSON.parse(body).name, privateToken: 'secret' }));
    return;
  }
  if (req.url === '/v2/billing') {
    const mode = req.headers.authorization;
    res.end(
      JSON.stringify({
        plan: mode === 'Bearer free' ? null : 'team',
        canManageBilling: true,
        credits:
          mode === 'Bearer credits' ? { balance: 1500, available: 1200, inFlight: 300 } : null,
        freeMonthlyLimits:
          mode === 'Bearer free'
            ? {
                generations: { used: 2, max: 3 },
                tts: { used: 4, max: 10 },
                monthlyResetDate: '2026-11-01T00:00:00.000Z',
              }
            : null,
        privateToken: 'secret',
      }),
    );
    return;
  }
  if (req.url === '/v2/usage/totals-with-completeness') {
    res.end(
      JSON.stringify({
        isComplete: req.headers.authorization !== 'Bearer incomplete',
        items: [
          { totalGenerationsAmountBilledCents: 125, totalFramesCount: 300 },
          { totalIntegrationsAmountBilledCents: 25, totalSecondsGenerated: 12 },
        ],
        privateToken: 'secret',
      }),
    );
    return;
  }
  res.writeHead(404).end('{}');
});
let client: Client;
let server: ReturnType<Awaited<ReturnType<typeof createMcpServerFactory>>['createServer']>;
beforeAll(async () => {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'http',
    port: 0,
  });
  server = factory.createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  await client.connect(ct);
});
afterAll(async () => {
  await client?.close();
  await server?.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});
function call(token: string, name: string, args: Record<string, unknown> = {}) {
  return runWithAuth(token, 'openai-mcp', () => client.callTool({ name, arguments: args }));
}

it('renames only the requested project through the authenticated patch boundary', async () => {
  const result = await call('member', 'rename-project', { projectId, name: '  Launch video  ' });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({ id: projectId, name: 'Launch video' });
  expect(writes).toEqual([{ token: 'Bearer member', body: { name: 'Launch video' } }]);
  expect(JSON.stringify(result)).not.toContain('secret');
});

it('refuses unauthorized or empty renames and never forwards extra mutation fields', async () => {
  const before = writes.length;
  expect(
    (await call('forbidden', 'rename-project', { projectId, name: 'No access' })).isError,
  ).toBe(true);
  expect((await call('member', 'rename-project', { projectId, name: ' ' })).isError).toBe(true);
  expect(writes).toHaveLength(before);
  await call('member', 'rename-project', {
    projectId,
    name: 'Name only',
    visibility: 'ORGANIZATION',
  });
  expect(writes.at(-1)?.body).toEqual({ name: 'Name only' });
});

it.each([
  ['credits', { balance: 1500, available: 1200, inFlight: 300 }, null],
  [
    'free',
    null,
    {
      generations: { used: 2, max: 3 },
      tts: { used: 4, max: 10 },
      monthlyResetDate: '2026-11-01T00:00:00.000Z',
    },
  ],
])('projects the %s allowance without exposing unrelated billing fields', async (token, credits, freeMonthlyLimits) => {
  const result = await call(token as string, 'get-account-usage');
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ credits, freeMonthlyLimits, usage: null });
  expect(JSON.stringify(result)).not.toContain('secret');
});

it('sums complete metered usage and retains the authoritative billing permission', async () => {
  const result = await call('member', 'get-account-usage');
  expect(result.structuredContent).toMatchObject({
    canManageBilling: false,
    usage: { totalCostCents: 150, totalFrames: 300, totalTtsSeconds: 12 },
  });
  expect((await call('admin', 'get-account-usage')).structuredContent).toMatchObject({
    canManageBilling: true,
  });
});

it('never presents incomplete or unauthorized usage as a zero total', async () => {
  const result = await call('incomplete', 'get-account-usage');
  expect(result.structuredContent).toMatchObject({ usage: null });
  expect((await call('forbidden', 'get-account-usage')).isError).toBe(true);
});
