import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createMcpServerFactory } from './server.js';
import { translationSpec } from './test-fixtures/translation.js';

afterEach(() => vi.unstubAllGlobals());

const QUOTE = 'ui://sync/card-quote-v1.html';
const USAGE = 'ui://sync/card-usage-v1.html';
const billing = {
  plan: 'creator',
  canManageBilling: true,
  credits: { balance: 2000, available: 1916, inFlight: 84 },
  freeMonthlyLimits: null,
};

/** A hosted server over a fixture API that records every request it is sent. */
async function connect(clientName: string) {
  const calls: { path: string; search: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === '/api-json')
      return Response.json({
        ...translationSpec,
        paths: {
          ...translationSpec.paths,
          '/v2/generations': {
            get: {
              operationId: 'GenerateController_getGenerations',
              tags: ['Generate'],
              parameters: [
                { name: 'limit', in: 'query', required: false, schema: { type: 'number' } },
              ],
            },
          },
        },
      });
    calls.push({
      path: url.pathname,
      search: url.search,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (url.pathname === '/v2/oauth/account')
      return Response.json({ organization: { id: 'org-1', name: 'Acme', role: 'owner' } });
    if (url.pathname === '/v2/billing') return Response.json(billing);
    if (url.pathname === '/v2/generations') return Response.json([{ id: 'generation-1' }]);
    if (url.pathname === '/v2/generate/estimate-cost')
      return Response.json({ estimatedGenerationCost: 0.84, estimatedCredits: 84 });
    return Response.json({}, { status: 404 });
  });
  const factory = await createMcpServerFactory({
    baseUrl: 'https://fixture.invalid',
    transport: 'http',
    port: 0,
    apiKey: 'fixture-key',
  });
  const server = factory.createServer();
  const client = new Client({ name: clientName, version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return { client, calls, close: () => Promise.all([client.close(), server.close()]) };
}

it.each(['openai-mcp', 'claude-ai'])(
  'shows the balance as a card to %s only through the tool made for showing it',
  async (clientName) => {
    const { client, close } = await connect(clientName);
    try {
      const { tools } = await client.listTools();
      const show = tools.find((tool) => tool.name === 'account_show-usage')!;
      expect(show._meta?.ui).toMatchObject({ resourceUri: USAGE });
      // The read the model makes for its own checks puts no card in the chat.
      const read = tools.find((tool) => tool.name === 'account_get-usage')!;
      expect((read._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBeUndefined();
      expect(show.inputSchema).toEqual(read.inputSchema);

      const shown = await client.callTool({ name: show.name, arguments: {} });
      expect(shown.structuredContent).toMatchObject({
        plan: 'creator',
        credits: { available: 1916, inFlight: 84 },
      });
      // The card is the packaged bundle, told which card to be.
      const card = await client.readResource({ uri: USAGE });
      expect(card.contents[0]).toMatchObject({ uri: USAGE });
      expect((card.contents[0] as { text: string }).text).toContain(
        '<meta name="sync-card" content="usage">',
      );
    } finally {
      await close();
    }
  },
);

it('keeps the tools that only show a card, and the cards, from a client that renders none', async () => {
  const { client, close } = await connect('cursor-vscode');
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('account_get-usage');
    expect(names.filter((name) => /_show(-|$)/.test(name))).toEqual([]);
    expect((await client.listResources()).resources).toEqual([]);
    await expect(client.readResource({ uri: USAGE })).rejects.toThrow(
      'This interface requires an app-compatible client.',
    );
  } finally {
    await close();
  }
});

it('shows the newest generations unless the model asks for another number', async () => {
  const { client, calls, close } = await connect('claude-ai');
  try {
    await client.callTool({ name: 'generations_show-recent', arguments: {} });
    await client.callTool({ name: 'generations_show-recent', arguments: { limit: 3 } });
    expect(
      calls.filter((call) => call.path === '/v2/generations').map((call) => call.search),
    ).toEqual(['?limit=12', '?limit=3']);
  } finally {
    await close();
  }
});

it('hands the price check card the create call to run, without sending it to the estimate', async () => {
  const { client, calls, close } = await connect('claude-ai');
  try {
    const { tools } = await client.listTools();
    const estimate = tools.find((tool) => tool.name === 'generations_estimate-cost')!;
    expect(estimate._meta?.ui).toMatchObject({ resourceUri: QUOTE });
    // The card's Create button calls the create tool itself.
    for (const name of ['dubbing_create', 'lipsync_create'])
      expect(tools.find((tool) => tool.name === name)?._meta?.ui).toMatchObject({
        visibility: ['model', 'app'],
      });

    const create = {
      tool: 'dubbing_create',
      arguments: { videoAssetId: 'video-1', targetLang: 'de', model: 'sync-3' },
    };
    const priced = { model: 'sync-3', duration: 222, workflow: 'translate-and-dub' };
    const quote = await client.callTool({
      name: estimate.name,
      arguments: { ...priced, create },
    });
    expect(quote.structuredContent).toMatchObject({
      estimatedCredits: 84,
      request: priced,
      create,
    });
    expect(calls.find((call) => call.path === '/v2/generate/estimate-cost')?.body).toEqual(priced);

    // A quote with no create call, or a malformed one, offers the card nothing to run.
    const plain = await client.callTool({ name: estimate.name, arguments: priced });
    expect(plain.structuredContent).not.toHaveProperty('create');
    expect(calls.some((call) => call.path === '/v2/generate')).toBe(false);
  } finally {
    await close();
  }
});
