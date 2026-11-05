import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncMcpServer } from './server.js';
import { ACME, api, cleanUp, connect, HOME, lipsync } from './test-fixtures/organizations.js';

// Device auth on stdio: a signed-in user, who can choose an organization per request.
vi.mock('./auth/token-store.js', () => ({
  loadToken: async () => 'device-token',
  saveToken: async () => {},
  clearToken: async () => {},
}));

afterEach(cleanUp);

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
    expect(home.structuredContent).toMatchObject({ features: ['stem_separation'] });

    const selected = await client.callTool({
      name: 'organizations_select',
      arguments: { organizationId: ACME.id },
    });
    expect(selected.structuredContent).toMatchObject({
      previousOrganization: HOME,
      features: ['scene_detection', 'stem_separation'],
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
