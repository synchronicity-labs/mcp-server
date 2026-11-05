import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpSession } from './http-session.js';
import { createMcpServerFactory } from './server.js';
import {
  ACME,
  api,
  cleanUp,
  connect,
  FOREIGN,
  GENERATION,
  HOME,
  hosted,
  lipsync,
  onCleanUp,
  UNGRANTED,
} from './test-fixtures/organizations.js';

afterEach(cleanUp);

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
    // The stub API needs no credential, so requests carry none.
    app.post('/:tab', async (req, res) => {
      await tabs[Number(req.params.tab)]!.handleRequest(req, res, req.body.method === 'initialize');
    });
    const listener = app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    onCleanUp(() => void listener.close());
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
      features: ['scene_detection', 'stem_separation'],
    });

    calls.length = 0;
    const context = await callTool(0, 'get-account-context');
    expect(context.structuredContent).toMatchObject({
      organization: { id: ACME.id, name: 'Acme', role: 'member' },
      plan: { id: 'scale' },
      features: ['scene_detection', 'stem_separation'],
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

  it('keeps a running create in the organization it started in when the session switches', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const projectStarted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { baseUrl, calls } = await api({
      intercept: async (call) => {
        if (call.method !== 'POST' || call.url !== '/v2/projects') return undefined;
        reached();
        await held;
        return undefined;
      },
    });
    const { call } = await hosted(baseUrl);
    const creating = call('create-lipsync', lipsync);
    await projectStarted;
    const switched = await call('organizations_select', { organizationId: ACME.id });
    expect(switched.isError).not.toBe(true);
    release();
    const created = await creating;
    expect(created.structuredContent).toMatchObject({ organization: HOME });
    const writes = calls.filter((item) => item.method === 'POST');
    expect(writes.map((item) => item.url)).toEqual(['/v2/projects', '/v2/generate']);
    expect(writes.every((item) => item.organization === undefined)).toBe(true);
  });

  it('refuses a write that names an id from another organization unless it names that organization', async () => {
    const { baseUrl, calls } = await api();
    const { call } = await hosted(baseUrl);
    const first = await call('create-lipsync', { ...lipsync, organizationId: ACME.id });
    const { projectId } = first.structuredContent as { projectId: string };
    const { projectCreationKey: _key, ...media } = lipsync;
    const again = { ...media, projectId, projectIntent: 'explicit' };

    calls.length = 0;
    const refused = await call('create-lipsync', again);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(`Pass organizationId \\"${ACME.id}\\"`);
    expect(calls).toEqual([]);

    const accepted = await call('create-lipsync', { ...again, organizationId: ACME.id });
    expect(accepted.structuredContent).toMatchObject({ organization: ACME });
    expect(
      calls.filter((item) => item.url === '/v2/generate').map((item) => item.organization),
    ).toEqual([ACME.id]);
  });

  it('treats the credential’s own organization as current for later writes', async () => {
    const { baseUrl, calls } = await api();
    const { call } = await hosted(baseUrl);
    // Nothing read yet: naming the default organization still runs without the header.
    const first = await call('create-lipsync', { ...lipsync, organizationId: HOME.id });
    expect(first.structuredContent).toMatchObject({ organization: HOME });
    expect(calls.every((item) => item.organization === undefined)).toBe(true);
    const { projectId } = first.structuredContent as { projectId: string };
    const { projectCreationKey: _key, ...media } = lipsync;
    const again = await call('create-lipsync', { ...media, projectId, projectIntent: 'explicit' });
    expect(again.isError).not.toBe(true);
    expect(again.structuredContent).toMatchObject({ organization: HOME });
  });

  it('reads what a create returned in its organization after the session switches away', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const generating = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { baseUrl, calls } = await api({
      intercept: async (call) => {
        if (call.method !== 'POST' || call.url !== '/v2/generate') return undefined;
        reached();
        await held;
        return undefined;
      },
    });
    const { call } = await hosted(baseUrl);
    await call('organizations_select', { organizationId: ACME.id });
    const creating = call('create-lipsync', { ...lipsync, organizationId: ACME.id });
    await generating;
    await call('organizations_select', { organizationId: HOME.id });
    release();
    expect((await creating).structuredContent).toMatchObject({ organization: ACME });

    calls.length = 0;
    await call('generate_get-generation', { id: GENERATION });
    expect(calls.map((item) => item.organization)).toEqual([ACME.id]);
  });

  it('reads the generation of an uncertain admission in the organization that admitted it', async () => {
    const { baseUrl, calls } = await api({
      intercept: (call) =>
        call.method === 'POST' && call.url === '/v2/generate'
          ? [
              503,
              {
                message: 'The outcome of this request is unknown',
                errorCode: 'IDEMPOTENCY_OUTCOME_UNKNOWN',
                generationId: GENERATION,
              },
            ]
          : undefined,
    });
    const { call } = await hosted(baseUrl);
    const created = await call('create-lipsync', { ...lipsync, organizationId: ACME.id });
    expect(created.structuredContent).toMatchObject({ error: { generationId: GENERATION } });

    calls.length = 0;
    const read = await call('generate_get-generation', { id: GENERATION });
    expect(read.isError).not.toBe(true);
    expect(calls.map((item) => item.organization)).toEqual([ACME.id]);
  });

  it('returns a create without its organization when the account read is slow', async () => {
    let stall!: () => void;
    const stalled = new Promise<void>((resolve) => {
      stall = resolve;
    });
    onCleanUp(() => stall());
    const { baseUrl } = await api({
      intercept: async (call) => {
        if (call.url === '/v2/account') await stalled;
        return undefined;
      },
    });
    const { call } = await hosted(baseUrl);
    const started = Date.now();
    const created = await call('create-lipsync', lipsync);
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({ id: GENERATION });
    expect(created.structuredContent).not.toHaveProperty('organization');
    expect(Date.now() - started).toBeLessThan(4_000);
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
        message: expect.stringContaining('You are not a member of the organization'),
        nextStep: expect.stringContaining('organizations_list'),
      },
    });

    const create = await call('create-lipsync', { ...lipsync, organizationId: FOREIGN });
    expect(create.isError).toBe(true);
    expect(JSON.stringify(create.content)).toContain('You are not a member of the organization');
    expect(calls.some((item) => item.url === '/v2/generate')).toBe(false);

    calls.length = 0;
    await call('get-account-context');
    expect(calls.every((item) => item.organization === undefined)).toBe(true);
  });

  it('passes on the API’s reconnect guidance for an organization the connection was not granted', async () => {
    let revoked = false;
    const { baseUrl, calls } = await api({
      // Acme's grant is disconnected after the switch.
      intercept: (call) =>
        revoked && call.organization === ACME.id
          ? [
              403,
              {
                message: 'This app connection has not been granted access to the organization',
                errorCode: 'oauth_organization_not_granted',
                suggestion: 'To add it, reconnect the app and tick that organization.',
              },
            ]
          : undefined,
    });
    const { call } = await hosted(baseUrl);
    const guidance = {
      status: 403,
      code: 'oauth_organization_not_granted',
      nextStep: expect.stringContaining('reconnect the app and tick that organization'),
    };

    const refused = await call('organizations_select', { organizationId: UNGRANTED });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ error: guidance });
    const create = await call('create-lipsync', { ...lipsync, organizationId: UNGRANTED });
    expect(create.structuredContent).toMatchObject({ error: guidance });
    expect(calls.some((item) => item.url === '/v2/generate')).toBe(false);
    const context = await call('get-account-context');
    expect(context.structuredContent).toMatchObject({
      organization: { id: HOME.id },
      organizationChoice: { selectedBy: 'credential' },
    });

    // A selection whose grant goes away mid-session: every call says what to do.
    await call('organizations_select', { organizationId: ACME.id });
    revoked = true;
    const later = await call('create-lipsync', lipsync);
    expect(later.structuredContent).toMatchObject({ error: guidance });
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
