import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

// billing-approval-links_create and the API's nextAction on refusals, against a stub API.
// An older API (under /old/) publishes no approval-link operation.
const link = {
  id: '00000000-0000-4000-8000-0000000000a1',
  url: 'https://sync.so/checkout/approve?organizationId=org-1&plan=pro&linkId=00000000-0000-4000-8000-0000000000a1',
  organization: { id: '00000000-0000-4000-8000-0000000000b2', name: 'Acme' },
  kind: 'plan',
  change: 'upgrade',
  plan: { id: 'pro', name: 'Pro' },
  credits: null,
  amountCents: 4900,
  currency: 'usd',
  interval: 'month',
  currentPlan: { id: 'hobby', name: 'Hobby' },
};
// Tagged as the API tags them: Billing is not a tag the parser generates tools from.
const op = (operationId: string, tag: string) => ({ operationId, tags: [tag] });
const spec = (approvals: boolean) => ({
  openapi: '3.0.0',
  paths: {
    '/v2/projects': { get: op('ProjectsController_getAll', 'Projects') },
    ...(approvals && {
      '/v2/billing/approval-links': { post: op('billingApprovalLinks_create', 'Billing') },
    }),
  },
});
const refusals: Record<string, Record<string, unknown>> = {
  'Bearer needs-plan': {
    statusCode: 402,
    errorCode: 'plan_feature_unavailable',
    message: 'This feature needs a higher plan.',
    requiredPlan: 'pro',
    billingUrl: 'https://sync.so/billing',
    nextAction: { type: 'upgrade_plan', url: 'https://sync.so/billing', requiredPlan: 'pro', x: 1 },
  },
  'Bearer needs-credits': {
    statusCode: 402,
    errorCode: 'insufficient_credits',
    message: 'Not enough credits.',
    requiredCredits: 800,
    availableCredits: 12,
    nextAction: { type: 'buy_credits', url: 'https://sync.so/billing' },
  },
  'Bearer busy': {
    statusCode: 429,
    errorCode: 'rate_limit_exceeded',
    message: 'Slow down.',
    nextAction: { type: 'retry_later', retryAfterSeconds: 20 },
  },
  'Bearer malformed': {
    statusCode: 402,
    errorCode: 'account_on_hold',
    message: 'On hold.',
    nextAction: { url: 'https://sync.so/billing' },
  },
};

const requests: { method?: string; path?: string; body?: unknown }[] = [];
const upstream = createServer(
  asyncRequestListener(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/api-json'))
      return void res.end(JSON.stringify(spec(!req.url.startsWith('/old/'))));
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined });
    const refusal = refusals[req.headers.authorization ?? ''];
    if (refusal) {
      res.statusCode = refusal.statusCode as number;
      return void res.end(JSON.stringify(refusal));
    }
    if (req.method === 'POST' && req.url === '/v2/billing/approval-links') {
      res.statusCode = 201;
      return void res.end(JSON.stringify({ ...link, internalNote: 'must-not-leak' }));
    }
    if (req.url === '/v2/projects') return void res.end('[]');
    res.statusCode = 404;
    res.end('{}');
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
  return client;
}

let claude: Client;
beforeAll(async () => {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  claude = await connect('claude-ai');
});
afterAll(async () => {
  for (const close of closers) await close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const call = (token: string, name: string, args: Record<string, unknown>) =>
  runWithAuth(token, 'claude-ai', () => claude.callTool({ name, arguments: args }));

describe('billing-approval-links_create', () => {
  it('is listed to Claude with its instructions, and not in the ChatGPT app', async () => {
    const tool = (await claude.listTools()).tools.find(
      (entry) => entry.name === 'billing-approval-links_create',
    );
    expect(tool).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      outputSchema: expect.any(Object),
    });
    expect(tool?.description).toContain('creates no charge');
    expect(tool?.description).toContain('account_get-context');
    expect(tool?.description).toContain('account_get-usage');
    expect(tool?.description).toMatch(/upgrade_plan.*buy_credits/);
    expect(claude.getInstructions()).toContain('billing-approval-links_create');
    expect(claude.getInstructions()).toContain('nextAction');

    const chatgpt = await connect('openai-mcp');
    const names = (await chatgpt.listTools()).tools.map((entry) => entry.name);
    expect(names).not.toContain('billing-approval-links_create');
    expect(names).toContain('account_get-usage');
    expect(chatgpt.getInstructions()).toContain('nextAction');
    expect(chatgpt.getInstructions()).not.toContain('billing-approval-links_create');
  });

  it('posts the plan or credits and returns the link without unlisted fields', async () => {
    const before = requests.length;
    const result = await call('account-one', 'billing-approval-links_create', { plan: 'pro' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(link);
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    await call('account-one', 'billing-approval-links_create', { credits: 800 });
    // The organization choice also reads /v2/account to name the organization.
    const posts = requests
      .slice(before)
      .filter((request) => request.path === '/v2/billing/approval-links');
    expect(posts).toEqual([
      { method: 'POST', path: '/v2/billing/approval-links', body: { plan: 'pro' } },
      { method: 'POST', path: '/v2/billing/approval-links', body: { credits: 800 } },
    ]);
  });

  it('takes a one-call organizationId, so a refused create elsewhere pays for that organization', async () => {
    const tool = (await claude.listTools()).tools.find(
      (entry) => entry.name === 'billing-approval-links_create',
    );
    expect(tool?.inputSchema.properties).toHaveProperty('organizationId');
    expect(claude.getInstructions()).toContain(
      'the same organizationId if the refused request used one',
    );
  });

  it('refuses both or neither of plan and credits before calling the API', async () => {
    const before = requests.length;
    for (const args of [{}, { plan: 'pro', credits: 800 }, { credits: 1.5 }]) {
      const result = await call('account-one', 'billing-approval-links_create', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(requests).toHaveLength(before);
  });

  it('is absent, and the server still starts, when the API does not publish the operation', async () => {
    const old = await connect('claude-ai', '/old');
    const names = (await old.listTools()).tools.map((entry) => entry.name);
    expect(names).toContain('projects_list');
    expect(names).not.toContain('billing-approval-links_create');
    expect(old.getInstructions()).toContain('When billing-approval-links_create is available');
  });
});

describe('nextAction on refusals', () => {
  it('passes an upgrade through and points at an approval link', async () => {
    const result = await call('needs-plan', 'projects_list', {});
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: Record<string, unknown> }).error;
    expect(error).toMatchObject({
      status: 402,
      code: 'plan_feature_unavailable',
      requiredPlan: 'pro',
      nextAction: { type: 'upgrade_plan', url: 'https://sync.so/billing', requiredPlan: 'pro' },
    });
    expect(error.nextAction).not.toHaveProperty('x');
    expect(error.nextStep).toContain('billing-approval-links_create');
    // The model reads the text block, not only structuredContent.
    const [text] = result.content as { type: string; text: string }[];
    expect(JSON.parse(text!.text).error.nextAction.type).toBe('upgrade_plan');
  });

  it('passes credits, retry timing and what to buy through', async () => {
    const credits = await call('needs-credits', 'projects_list', {});
    expect((credits.structuredContent as { error: unknown }).error).toMatchObject({
      requiredCredits: 800,
      nextAction: { type: 'buy_credits' },
      nextStep: expect.stringContaining('account_get-usage'),
    });
    const busy = await call('busy', 'projects_list', {});
    expect((busy.structuredContent as { error: unknown }).error).toMatchObject({
      status: 429,
      nextAction: { type: 'retry_later', retryAfterSeconds: 20 },
      nextStep: expect.stringContaining('retryAfterSeconds'),
    });
  });

  it('drops a malformed nextAction and keeps the rest of the refusal', async () => {
    const result = await call('malformed', 'projects_list', {});
    const error = (result.structuredContent as { error: Record<string, unknown> }).error;
    expect(error).toMatchObject({ status: 402, code: 'account_on_hold' });
    expect(error).not.toHaveProperty('nextAction');
  });
});
