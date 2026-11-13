import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

// billing-plans_list against a stub API. An older API (under /old/) has no plans route.
const TOOL = 'billing-plans_list';
const OTHER_ORGANIZATION = '00000000-0000-4000-8000-0000000000c3';
const organization = { id: '00000000-0000-4000-8000-0000000000b2', name: 'personal' };
const catalog = {
  organization,
  billingModel: 'free',
  currentPlan: { id: 'free', name: 'Free' },
  plans: [
    {
      id: 'hobby',
      name: 'Hobby',
      amountCents: 500,
      currency: 'usd',
      interval: 'month',
      monthlyCredits: 300,
      limits: { maxOutputDurationSeconds: 60, concurrency: 3 },
      change: 'subscribe',
      unavailableReason: null,
    },
  ],
  credits: null,
  agentPayments: true,
};

const askedFor: (string | undefined)[] = [];
const upstream = createServer(
  asyncRequestListener(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/api-json'))
      return void res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
    const selected = req.headers['x-sync-organization-id'] as string | undefined;
    if (req.url?.endsWith('/v2/account'))
      return void res.end(
        JSON.stringify({
          plan: { id: 'free', name: 'Free' },
          organization: { ...organization, id: selected ?? organization.id },
        }),
      );
    if (req.method === 'GET' && req.url === '/v2/billing/plans') {
      askedFor.push(selected);
      return void res.end(JSON.stringify({ ...catalog, internalNote: 'must-not-leak' }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ statusCode: 404, message: `Cannot ${req.method} ${req.url}` }));
  }),
);

let baseUrl: string;
const closers: (() => Promise<void>)[] = [];
async function connect(clientName: string, path = '') {
  const factory = await createMcpServerFactory({
    baseUrl: `${baseUrl}${path}`,
    transport: 'http',
    port: 0,
  });
  const server = factory.createServer(clientName);
  const client = new Client({ name: clientName, version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  const as = <T>(work: () => Promise<T>) => runWithAuth('token', clientName, work);
  return {
    lists: async () => (await as(() => client.listTools())).tools.some((t) => t.name === TOOL),
    call: (args: Record<string, unknown> = {}) =>
      as(() => client.callTool({ name: TOOL, arguments: args })),
  };
}

beforeAll(async () => {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const close of closers) await close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('billing-plans_list', () => {
  it('returns the plans and prices the API lists, and nothing it did not declare', async () => {
    const agent = await connect('claude-code');

    const result = await agent.call();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(catalog);
  });

  it('prices another organization when given its organizationId', async () => {
    const agent = await connect('claude-code');
    askedFor.length = 0;

    await agent.call();
    await agent.call({ organizationId: OTHER_ORGANIZATION });

    expect(askedFor).toEqual([undefined, OTHER_ORGANIZATION]);
  });

  it('is listed to Claude and coding agents, and not in the OpenAI listing', async () => {
    expect(await (await connect('claude-code')).lists()).toBe(true);
    expect(await (await connect('claude-ai')).lists()).toBe(true);
    expect(await (await connect('openai-mcp')).lists()).toBe(false);
    expect(await (await connect('openai-mcp (Codex)')).lists()).toBe(false);
  });

  it('says how to get one price when the API is too old to list plans', async () => {
    const old = await connect('claude-code', '/old');

    const result = await old.call();

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('does not list plans yet');
    expect(JSON.stringify(result.content)).toContain('billing-approval-links_create');
  });
});
