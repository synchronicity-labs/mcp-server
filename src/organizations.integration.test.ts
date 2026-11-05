import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { HttpSession } from './http-session.js';
import { ORGANIZATION_HEADER } from './organization-selection.js';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

// Device auth on stdio: a signed-in user, who can choose an organization per request.
vi.mock('./auth/token-store.js', () => ({
  loadToken: async () => 'device-token',
  saveToken: async () => {},
  clearToken: async () => {},
}));

const HOME = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Home' };
const ACME = { id: '00000000-0000-4000-8000-0000000000a2', name: 'Acme' };
const FOREIGN = '00000000-0000-4000-8000-0000000000a3';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const GENERATION = '00000000-0000-4000-8000-0000000000c1';
const USER = { id: '00000000-0000-4000-8000-0000000000d1', email: 'u@example.test', name: 'U' };

const ORGS = {
  [HOME.id]: {
    ...HOME,
    role: 'owner',
    plan: { id: 'free', name: 'Free' },
    limits: { concurrency: 1, maxOutputDurationSeconds: 60 },
    features: { 'stem-separation': true, 'scene-detection': false },
  },
  [ACME.id]: {
    ...ACME,
    role: 'member',
    plan: { id: 'scale', name: 'Scale' },
    limits: { concurrency: 15, maxOutputDurationSeconds: 1800 },
    features: { 'stem-separation': true, 'scene-detection': true },
  },
} as const;

const spec = {
  openapi: '3.0.0',
  paths: {
    '/v2/generate/{id}': {
      get: {
        operationId: 'GenerateController_getGeneration',
        tags: ['Generate'],
        summary: 'Get a generation',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  },
};

type Call = { method: string; url: string; organization?: string; headers: IncomingHttpHeaders };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

type Org = (typeof ORGS)[keyof typeof ORGS];
type Reply = [status: number, body: unknown];

const refusal = (message: string, errorCode: string): Reply => [403, { message, errorCode }];

/** Account reads as the API answers them for `org`. */
function accountReply(url: string, org: Org, apiKey: boolean): Reply | undefined {
  const organization = { id: org.id, name: org.name, role: apiKey ? 'owner' : org.role };
  const account = apiKey ? null : USER;
  const replies: Record<string, unknown> = {
    '/v2/account': {
      account,
      organization,
      credentialType: apiKey ? 'api_key' : 'session',
      plan: org.plan,
      limits: { ...org.limits, maxFileSizeBytes: 1 },
      features: org.features,
    },
    '/v2/oauth/account': { account, organization },
    '/v2/plans/limits': { seats: 3, voiceClone: 5 },
    '/v2/account/organizations': {
      organizations: Object.values(ORGS).map((item) => ({
        id: item.id,
        name: item.name,
        role: item.role,
        plan: item.plan,
        isCurrent: item.id === org.id,
      })),
    },
  };
  return url in replies ? [200, replies[url]] : undefined;
}

function generationReply(method: string, url: string, body: Record<string, unknown>): Reply {
  if (method === 'POST' && url === '/v2/projects') return [200, { id: body.id ?? PROJECT }];
  if (method === 'POST' && url === '/v2/generate')
    return [200, { id: GENERATION, status: 'PENDING', projectId: body.projectId }];
  if (url.startsWith(`/v2/generate/${GENERATION}`))
    return [200, { id: GENERATION, status: 'PROCESSING' }];
  return [404, { message: `Cannot ${method} ${url}` }];
}

/** A Sync API that honours the organization header for users, unless `ignoresHeader`. */
async function api(options: { ignoresHeader?: boolean } = {}) {
  const calls: Call[] = [];
  const reply = (call: Call, body: Record<string, unknown>): Reply => {
    const apiKey = call.headers['x-api-key'] !== undefined;
    const requested = call.organization;
    if (requested && apiKey)
      return refusal(
        'API keys are bound to their organization',
        'organization_selection_not_allowed',
      );
    if (requested && !(requested in ORGS))
      return refusal('You are not a member of this organization', 'organization_access_denied');
    const org = ORGS[requested && !options.ignoresHeader ? requested : HOME.id]!;
    return accountReply(call.url, org, apiKey) ?? generationReply(call.method, call.url, body);
  };
  const upstream: Server = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') return void res.end(JSON.stringify(spec));
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const header = req.headers[ORGANIZATION_HEADER];
      const call: Call = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        ...(typeof header === 'string' ? { organization: header } : {}),
      };
      calls.push(call);
      const [status, body] = reply(
        call,
        chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {},
      );
      res.writeHead(status).end(JSON.stringify(body));
    }),
  );
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  cleanups.push(() => void upstream.close());
  return { baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, calls };
}

async function connect(server: { connect: (transport: never) => Promise<void> }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as never);
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(clientTransport);
  cleanups.push(() => client.close());
  return client;
}

/** A hosted server over the in-memory transport; tool calls run as an OAuth user. */
async function hosted(baseUrl: string) {
  const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
  const client = await connect(factory.createServer());
  return {
    call: (name: string, args: Record<string, unknown> = {}) =>
      runWithAuth('oauth-user', 'claude-code', () => client.callTool({ name, arguments: args })),
  };
}

const lipsync = {
  videoUrl: 'https://example.test/v.mp4',
  audioUrl: 'https://example.test/a.wav',
  projectCreationKey: '00000000-0000-4000-8000-0000000000e1',
};

describe('organizations on the hosted server', () => {
  it('keeps a selection per MCP session across per-request servers, sending the header after it', async () => {
    const { baseUrl, calls } = await api();
    const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
    const tabs = [
      new HttpSession('claude-code', factory.createServer, () => {}),
      new HttpSession('claude-code', factory.createServer, () => {}),
    ];
    const app = express();
    app.use(express.json());
    app.post('/:tab', async (req, res) => {
      await runWithAuth('oauth-user', 'claude-code', () =>
        tabs[Number(req.params.tab)]!.handleRequest(req, res, req.body.method === 'initialize'),
      );
    });
    const listener = app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    cleanups.push(() => void listener.close());
    const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    let nextId = 1;
    const post = async (tab: number, method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(`${url}/${tab}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          ...(method.startsWith('notifications/') ? {} : { id: nextId++ }),
          method,
          params,
        }),
      });
      return response.status === 202
        ? undefined
        : ((await response.json()) as {
            result: { tools: { name: string }[]; structuredContent?: unknown; isError?: boolean };
          });
    };
    for (const tab of [0, 1]) {
      await post(tab, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-code', version: '1' },
      });
      await post(tab, 'notifications/initialized');
    }
    const callTool = async (tab: number, name: string, args: Record<string, unknown> = {}) =>
      (await post(tab, 'tools/call', { name, arguments: args }))!.result;

    const listed = (await post(0, 'tools/list'))!.result.tools.map((tool) => tool.name);
    expect(listed).toEqual(expect.arrayContaining(['organizations_list', 'organizations_select']));

    const before = await callTool(0, 'organizations_list');
    expect(before.structuredContent).toMatchObject({
      current: HOME,
      selectedBy: 'credential',
      organizations: [
        { id: HOME.id, isCurrent: true, role: 'owner', plan: { id: 'free' } },
        { id: ACME.id, isCurrent: false, role: 'member' },
      ],
    });

    const selected = await callTool(0, 'organizations_select', { organizationId: ACME.id });
    expect(selected.isError).not.toBe(true);
    expect(selected.structuredContent).toMatchObject({
      organization: { id: ACME.id, name: 'Acme', role: 'member' },
      previousOrganization: HOME,
      changed: true,
      plan: { id: 'scale', name: 'Scale' },
      generationLimits: { concurrency: 15, maxOutputDurationSeconds: 1800 },
      features: ['scene-detection', 'stem-separation'],
    });

    calls.length = 0;
    const context = await callTool(0, 'get-account-context');
    expect(context.structuredContent).toMatchObject({
      organization: { id: ACME.id, name: 'Acme', role: 'member' },
      plan: { id: 'scale' },
      features: ['scene-detection', 'stem-separation'],
      organizationChoice: { selectedBy: 'session' },
    });
    expect(calls.map((call) => call.organization)).toEqual([ACME.id, ACME.id, ACME.id]);

    const after = await callTool(0, 'organizations_list');
    expect(after.structuredContent).toMatchObject({ current: ACME, selectedBy: 'session' });

    // Another session of the same user keeps its own organization.
    calls.length = 0;
    const other = await callTool(1, 'get-account-context');
    expect(other.structuredContent).toMatchObject({
      organization: { id: HOME.id },
      organizationChoice: { selectedBy: 'credential' },
    });
    expect(calls.every((call) => call.organization === undefined)).toBe(true);
  });

  it('runs one create in another organization, keeps its reads there, and reports the organization', async () => {
    const { baseUrl, calls } = await api();
    const { call } = await hosted(baseUrl);

    const created = await call('create-lipsync', { ...lipsync, organizationId: ACME.id });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({ id: GENERATION, organization: ACME });
    const generate = calls.find((item) => item.method === 'POST' && item.url === '/v2/generate');
    expect(generate?.organization).toBe(ACME.id);
    expect(calls.find((item) => item.url === '/v2/projects')?.organization).toBe(ACME.id);

    calls.length = 0;
    const read = await call('generate_get-generation', { id: GENERATION });
    expect(read.isError).not.toBe(true);
    expect(calls.filter((item) => item.url.startsWith('/v2/generate/'))).toEqual([
      expect.objectContaining({ organization: ACME.id }),
    ]);

    // The session itself never switched.
    calls.length = 0;
    const next = await call('create-lipsync', {
      ...lipsync,
      projectCreationKey: '00000000-0000-4000-8000-0000000000e2',
    });
    expect(next.structuredContent).toMatchObject({ organization: HOME });
    expect(calls.every((item) => item.organization === undefined)).toBe(true);
    const context = await call('get-account-context');
    expect(context.structuredContent).toMatchObject({
      organization: { id: HOME.id },
      organizationChoice: { selectedBy: 'credential' },
    });
  });

  it('keeps identical concurrent creates in different organizations apart', async () => {
    const { baseUrl, calls } = await api();
    const { call } = await hosted(baseUrl);
    const results = await Promise.all([
      call('create-lipsync', lipsync),
      call('create-lipsync', { ...lipsync, organizationId: ACME.id }),
    ]);
    expect(
      results.map(
        (result) =>
          (result.structuredContent as { organization?: unknown } | undefined)?.organization,
      ),
    ).toEqual([HOME, ACME]);
    const submitted = calls.filter((item) => item.method === 'POST' && item.url === '/v2/generate');
    expect(submitted).toHaveLength(2);
    expect(submitted.map((item) => item.organization)).toEqual(
      expect.arrayContaining([ACME.id, undefined]),
    );
  });

  it('surfaces the API refusal for a non-member organization and keeps the session unchanged', async () => {
    const { baseUrl, calls } = await api();
    const { call } = await hosted(baseUrl);

    const refused = await call('organizations_select', { organizationId: FOREIGN });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      error: {
        status: 403,
        code: 'organization_access_denied',
        message: expect.stringContaining('You are not a member of this organization'),
        nextStep: expect.stringContaining('organizations_list'),
      },
    });

    const create = await call('create-lipsync', { ...lipsync, organizationId: FOREIGN });
    expect(create.isError).toBe(true);
    expect(JSON.stringify(create.content)).toContain('You are not a member of this organization');
    expect(calls.some((item) => item.url === '/v2/generate')).toBe(false);

    calls.length = 0;
    await call('get-account-context');
    expect(calls.every((item) => item.organization === undefined)).toBe(true);
  });

  it('refuses to record a switch the API did not apply', async () => {
    const { baseUrl, calls } = await api({ ignoresHeader: true });
    const { call } = await hosted(baseUrl);

    const result = await call('organizations_select', { organizationId: ACME.id });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Sync did not switch to organization');
    const create = await call('create-lipsync', { ...lipsync, organizationId: ACME.id });
    expect(create.isError).toBe(true);
    expect(calls.some((item) => item.url === '/v2/generate')).toBe(false);
  });

  it('adds organizationId to paid creates and their estimates only', async () => {
    const { baseUrl } = await api();
    const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
    const client = await connect(factory.createServer());
    const { tools } = await client.listTools();
    const withChoice = tools
      .filter((tool) => 'organizationId' in (tool.inputSchema.properties ?? {}))
      .map((tool) => tool.name);
    expect(withChoice).toEqual(
      expect.arrayContaining(['create-lipsync', 'create-timeline-lipsync', 'organizations_select']),
    );
    expect(withChoice).not.toContain('generate_get-generation');
    const lipsyncTool = tools.find((tool) => tool.name === 'create-lipsync')!;
    expect(JSON.stringify(lipsyncTool.outputSchema)).toContain('"organization"');
  });
});

describe('organizations on stdio', () => {
  it('binds API keys to their organization and never sends the header', async () => {
    const { baseUrl, calls } = await api();
    const server = await createSyncMcpServer({
      baseUrl,
      transport: 'stdio',
      port: 0,
      apiKey: 'sk-test',
    });
    const client = await connect(server);

    const listed = await client.callTool({ name: 'organizations_list', arguments: {} });
    expect(listed.structuredContent).toMatchObject({
      organizations: [{ id: HOME.id, name: 'Home', isCurrent: true, plan: { id: 'free' } }],
      current: HOME,
      selectedBy: 'credential',
      howToSwitch: expect.stringContaining('API key'),
    });

    const other = await client.callTool({
      name: 'organizations_select',
      arguments: { organizationId: ACME.id },
    });
    expect(other.isError).toBe(true);
    expect(JSON.stringify(other.content)).toContain('API keys are bound to one organization');

    const own = await client.callTool({
      name: 'organizations_select',
      arguments: { organizationId: HOME.id },
    });
    expect(own.structuredContent).toMatchObject({
      organization: { id: HOME.id },
      changed: false,
      plan: { id: 'free' },
    });

    const create = await client.callTool({
      name: 'create-lipsync',
      arguments: { ...lipsync, organizationId: ACME.id },
    });
    expect(create.isError).toBe(true);
    expect(JSON.stringify(create.content)).toContain('API keys are bound to one organization');
    const sameOrg = await client.callTool({
      name: 'create-lipsync',
      arguments: { ...lipsync, organizationId: HOME.id },
    });
    expect(sameOrg.structuredContent).toMatchObject({ organization: HOME });

    const context = await client.callTool({ name: 'get-account-context', arguments: {} });
    expect(context.structuredContent).toMatchObject({
      organizationChoice: {
        selectedBy: 'credential',
        howToSwitch: expect.stringContaining('API key'),
      },
    });
    expect(calls.some((item) => item.organization !== undefined)).toBe(false);
  });

  it('re-reads features after a switch and tells the client its tool list changed', async () => {
    const { baseUrl, calls } = await api();
    const server = await createSyncMcpServer({ baseUrl, transport: 'stdio', port: 0 });
    const client = await connect(server);
    let changes = 0;
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      changes++;
    });

    const home = await client.callTool({ name: 'get-account-context', arguments: {} });
    expect(home.structuredContent).toMatchObject({ features: ['stem-separation'] });

    const selected = await client.callTool({
      name: 'organizations_select',
      arguments: { organizationId: ACME.id },
    });
    expect(selected.structuredContent).toMatchObject({
      previousOrganization: HOME,
      features: ['scene-detection', 'stem-separation'],
    });
    await vi.waitFor(() => expect(changes).toBe(1));

    // Selecting the same organization again changes nothing.
    await client.callTool({ name: 'organizations_select', arguments: { organizationId: ACME.id } });
    calls.length = 0;
    const created = await client.callTool({ name: 'create-lipsync', arguments: lipsync });
    expect(created.structuredContent).toMatchObject({ organization: ACME });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((item) => item.organization === ACME.id)).toBe(true);
    expect(calls.every((item) => item.headers.authorization === 'Bearer device-token')).toBe(true);
    expect(changes).toBe(1);
  });
});
