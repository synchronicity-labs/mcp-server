import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

// billing-payment-links_create against a stub API: listed only to coding agents whose
// account has agent_payments, and never callable from an app-directory client.
const TOOL = 'billing-payment-links_create';
const link = {
  url: 'https://api.sync.so/v2/billing/payment-links/token-1',
  expiresAt: '2026-11-13T15:00:00.000Z',
  kind: 'plan',
  plan: 'hobby',
  credits: null,
  amountCents: 500,
  currency: 'usd',
  interval: 'month',
  networkId: 'profile_test_1',
  organization: { id: '00000000-0000-4000-8000-0000000000b2', name: 'personal' },
};

const requests: { path?: string; body?: unknown }[] = [];
const upstream = createServer(
  asyncRequestListener(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api-json')
      return void res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
    if (req.url === '/v2/account') {
      const features = req.headers.authorization === 'Bearer payer' ? ['agent_payments'] : [];
      return void res.end(JSON.stringify({ plan: { id: 'free', name: 'Free' }, features }));
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: raw ? JSON.parse(raw) : undefined });
    if (req.method === 'POST' && req.url === '/v2/billing/payment-links') {
      res.statusCode = 201;
      return void res.end(JSON.stringify({ ...link, internalNote: 'must-not-leak' }));
    }
    res.statusCode = 404;
    res.end('{}');
  }),
);

let baseUrl: string;
const closers: (() => Promise<void>)[] = [];
async function connect(clientName: string) {
  const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
  const server = factory.createServer(clientName);
  const client = new Client({ name: clientName, version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  const as = <T>(token: string, work: () => Promise<T>) => runWithAuth(token, clientName, work);
  return {
    lists: async (token: string) =>
      (await as(token, () => client.listTools())).tools.some((tool) => tool.name === TOOL),
    call: (token: string, args: Record<string, unknown>) =>
      as(token, () => client.callTool({ name: TOOL, arguments: args })),
  };
}

beforeAll(async () => {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
beforeEach(() => {
  requests.length = 0;
});
afterAll(async () => {
  for (const close of closers) await close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('billing-payment-links_create', () => {
  it('is listed to a coding agent only where the account takes agent payments', async () => {
    const agent = await connect('claude-code');

    expect(await agent.lists('payer')).toBe(true);
    expect(await (await connect('claude-code')).lists('no-payments')).toBe(false);
  });

  it('returns the link the wallet pays, for a plan or for credits', async () => {
    const agent = await connect('claude-code');

    const result = await agent.call('payer', { plan: 'hobby' });
    await agent.call('payer', { credits: 800 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(link);
    expect(requests).toEqual([
      { path: '/v2/billing/payment-links', body: { plan: 'hobby' } },
      { path: '/v2/billing/payment-links', body: { credits: 800 } },
    ]);
  });

  it.each([[{}], [{ plan: 'hobby', credits: 800 }]])(
    'asks for exactly one of plan or credits: %j',
    async (args) => {
      const agent = await connect('claude-code');

      const result = await agent.call('payer', args);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('exactly one of plan or credits');
      expect(requests).toEqual([]);
    },
  );

  it.each(['openai-mcp', 'openai-mcp (Codex)', 'claude-ai'])(
    'is neither listed nor callable in an app-directory client: %s',
    async (clientName) => {
      const app = await connect(clientName);

      expect(await app.lists('payer')).toBe(false);
      const result = await app.call('payer', { plan: 'hobby' });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('not available in this client');
      expect(requests).toEqual([]);
    },
  );
});
