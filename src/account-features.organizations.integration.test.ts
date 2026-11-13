import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';
import { ACME, api, cleanUp, connect, HOME } from './test-fixtures/organizations.js';

// Feature-gated tools follow the session's active organization. In the fixture, Home has
// stem_separation and Acme has stem_separation and scene_detection.
vi.mock('./auth/token-store.js', () => ({
  loadToken: async () => 'device-token',
  loadCredentials: async () => null,
  saveToken: async () => {},
  clearToken: async () => {},
}));

afterEach(cleanUp);

const GATED = ['scenes_detect', 'stems_separate'];
const gated = async (list: () => ReturnType<Client['listTools']>) =>
  (await list()).tools.map((tool) => tool.name).filter((name) => GATED.includes(name));

describe('feature-gated tools across organizations', () => {
  it('follow organizations_select on stdio', async () => {
    const { baseUrl, calls } = await api();
    const client = await connect(
      await createSyncMcpServer({ baseUrl, transport: 'stdio', port: 0 }),
    );
    const list = () => client.listTools();
    const select = (organizationId: string) =>
      client.callTool({ name: 'organizations_select', arguments: { organizationId } });

    expect(await gated(list)).toEqual(['stems_separate']);
    expect((await select(ACME.id)).isError).not.toBe(true);
    expect(await gated(list)).toEqual(GATED);
    expect((await select(HOME.id)).isError).not.toBe(true);
    expect(await gated(list)).toEqual(['stems_separate']);
    // Only the first list read the account; the switches wrote the session's features.
    expect(calls.filter((call) => call.url === '/v2/account' && !call.organization)).toHaveLength(
      1,
    );
  });

  it('follow organizations_select on the hosted server, reading as the selected organization', async () => {
    const { baseUrl, calls } = await api();
    const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
    const client = await connect(factory.createServer());
    const asUser = <T>(fn: () => T) => runWithAuth('oauth-user', 'claude-code', fn);
    const list = () => asUser(() => client.listTools());

    await asUser(() =>
      client.callTool({ name: 'organizations_select', arguments: { organizationId: ACME.id } }),
    );
    expect(await gated(list)).toEqual(GATED);
    await asUser(() =>
      client.callTool({ name: 'organizations_select', arguments: { organizationId: HOME.id } }),
    );
    expect(await gated(list)).toEqual(['stems_separate']);
    // Selecting read each organization's account; listing needed no read of its own.
    expect(
      calls.filter((call) => call.url === '/v2/account').map((call) => call.organization),
    ).toEqual([ACME.id, HOME.id]);
  });

  it('keeps Acme’s tools when a account_get-context read in Home lands after the switch', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    const { baseUrl } = await api({
      intercept: async (call) => {
        // Hold account_get-context's header-less read of Home's account.
        if (holding && call.url === '/v2/account' && !call.organization) {
          holding = false;
          await held;
        }
        return undefined;
      },
    });
    const client = await connect(
      await createSyncMcpServer({ baseUrl, transport: 'stdio', port: 0 }),
    );
    const context = client.callTool({ name: 'account_get-context', arguments: {} });
    await vi.waitFor(() => expect(holding).toBe(false));
    await client.callTool({ name: 'organizations_select', arguments: { organizationId: ACME.id } });
    expect(await gated(() => client.listTools())).toEqual(GATED);
    release();
    // The call itself reports Home, where it started.
    expect((await context).structuredContent).toMatchObject({
      organization: { id: HOME.id },
      features: ['stem_separation'],
    });
    // Home's late answer must not replace Acme's features in the session.
    expect(await gated(() => client.listTools())).toEqual(GATED);
    expect(await gated(() => client.listTools())).toEqual(GATED);
  });

  it('keeps the new organization’s features when a list read finishes after a switch', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    const { baseUrl } = await api({
      intercept: async (call) => {
        // Hold the first, header-less account read: the one tools/list makes.
        if (holding && call.url === '/v2/account' && !call.organization) {
          holding = false;
          await held;
        }
        return undefined;
      },
    });
    const client = await connect(
      await createSyncMcpServer({ baseUrl, transport: 'stdio', port: 0 }),
    );
    const pending = gated(() => client.listTools());
    await vi.waitFor(() => expect(holding).toBe(false));
    await client.callTool({ name: 'organizations_select', arguments: { organizationId: ACME.id } });
    release();
    // That list answered for Home, where it started; the session now runs in Acme.
    expect(await pending).toEqual(['stems_separate']);
    expect(await gated(() => client.listTools())).toEqual(GATED);
  });
});
