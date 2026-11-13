import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createMcpServerFactory } from './server.js';
import { translationSpec } from './test-fixtures/translation.js';

afterEach(() => vi.unstubAllGlobals());

const QUOTE = 'ui://sync/card-quote-v1.html';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USAGE = 'ui://sync/card-usage-v1.html';
const GENERATION = '00000000-0000-4000-8000-000000000003';
const TIMELINE = '00000000-0000-4000-8000-000000000004';
const ORGANIZATION = '00000000-0000-4000-8000-000000000005';
const billing = {
  plan: 'creator',
  canManageBilling: true,
  credits: { balance: 2000, available: 1916, inFlight: 84 },
  freeMonthlyLimits: null,
};

/** A hosted server over a fixture API that records every request it is sent. */
async function connect(clientName: string, { accountDown = false } = {}) {
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
      return Response.json({ organization: { id: ORGANIZATION, name: 'Acme', role: 'owner' } });
    if (url.pathname === '/v2/billing') return Response.json(billing);
    if (url.pathname === '/v2/account' && accountDown)
      return Response.json({ message: 'Unavailable' }, { status: 503 });
    if (url.pathname === '/v2/account')
      return Response.json({
        organization: { id: ORGANIZATION, name: 'Acme' },
        plan: { id: 'pro', name: 'Pro' },
        features: ['lipsync_planning'],
      });
    if (
      url.pathname === `/v2/generate/${GENERATION}` ||
      url.pathname === `/v2/generate/${TIMELINE}`
    )
      return Response.json({
        id: url.pathname.split('/').at(-1),
        status: 'COMPLETED',
        model: 'sync-3',
        outputUrl: 'https://fixture.invalid/result.mp4',
        // Four seconds, like the 96 frames at 24 a second the review is opened with.
        outputDuration: 4,
        input: [
          { type: 'video', url: 'https://fixture.invalid/source.mp4' },
          { type: 'audio', url: 'https://fixture.invalid/voice.wav' },
        ],
        summary: { title: 'Keynote in German' },
        ...(url.pathname.endsWith(TIMELINE) ? { segments: [{ startFrame: 0, endFrame: 47 }] } : {}),
      });
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
    const shown = await client.callTool({ name: 'generations_show-recent', arguments: {} });
    // A named list, so the entries reach a card as structured content on every host.
    expect(shown.structuredContent).toEqual({ generations: [{ id: 'generation-1' }] });
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
      // The quote mints the keys its create call must use, however often the card reloads:
      // one for the generation, and one for the new project it goes into.
      create: {
        tool: create.tool,
        arguments: { ...create.arguments, projectCreationKey: expect.stringMatching(UUID) },
        idempotencyKey: expect.stringMatching(UUID),
      },
    });
    expect(calls.find((call) => call.path === '/v2/generate/estimate-cost')?.body).toEqual(priced);

    // A quote with no create call offers the card nothing to run.
    const plain = await client.callTool({ name: estimate.name, arguments: priced });
    expect(plain.structuredContent).not.toHaveProperty('create');

    // The person approves a price, so a call for other work than the quote prices is
    // refused before anything is quoted: another workflow, or another model.
    const quotes = calls.filter((call) => call.path === '/v2/generate/estimate-cost').length;
    const lipsyncQuote = await client.callTool({
      name: estimate.name,
      arguments: { model: 'sync-3', duration: 222, create },
    });
    expect(JSON.stringify(lipsyncQuote.content)).toContain(
      'create.tool is dubbing_create but this quote prices a lipsync',
    );
    const otherModel = await client.callTool({
      name: estimate.name,
      arguments: { ...priced, model: 'lipsync-2-pro', create },
    });
    expect(JSON.stringify(otherModel.content)).toContain(
      'create.arguments.model is sync-3 but this quote prices lipsync-2-pro',
    );
    // The call runs in the organization the quote ran in, whatever the session does later,
    // and may not name another.
    expect(
      (quote.structuredContent as { create: { arguments: unknown } }).create.arguments,
    ).toMatchObject({
      organizationId: ORGANIZATION,
    });
    const elsewhere = await client.callTool({
      name: estimate.name,
      arguments: {
        ...priced,
        create: {
          ...create,
          arguments: {
            ...create.arguments,
            organizationId: '00000000-0000-4000-8000-000000000006',
          },
        },
      },
    });
    expect(JSON.stringify(elsewhere.content)).toContain(
      'but this quote runs in the session’s organization',
    );
    // Reasoning costs more: a call that turns it on needs a quote that priced it, and a
    // quote that priced it needs a call that uses it.
    const pro = { model: 'lipsync-2-pro', duration: 222 };
    const reasoning = {
      tool: 'lipsync_create',
      arguments: { videoAssetId: 'video-1', audioAssetId: 'audio-1' },
    };
    const withReasoning = {
      ...reasoning,
      arguments: { ...reasoning.arguments, options: { reasoning_enabled: true } },
    };
    const cheaper = await client.callTool({
      name: estimate.name,
      arguments: { ...pro, create: withReasoning },
    });
    expect(JSON.stringify(cheaper.content)).toContain(
      'reasoning_enabled is true but this quote prices the job without reasoning',
    );
    const dearer = await client.callTool({
      name: estimate.name,
      arguments: { ...pro, reasoningEnabled: true, create: reasoning },
    });
    expect(JSON.stringify(dearer.content)).toContain(
      'This quote prices reasoning, but the create call does not use it',
    );
    expect(calls.filter((call) => call.path === '/v2/generate/estimate-cost')).toHaveLength(quotes);
    const matched = await client.callTool({
      name: estimate.name,
      arguments: { ...pro, reasoningEnabled: true, create: withReasoning },
    });
    expect(matched.structuredContent).toMatchObject({
      create: { arguments: { options: { reasoning_enabled: true } } },
    });
    expect(calls.filter((call) => call.path === '/v2/generate/estimate-cost')).toHaveLength(
      quotes + 1,
    );
    expect(calls.some((call) => call.path === '/v2/generate')).toBe(false);
  } finally {
    await close();
  }
});

it('gives the card no call to run when the quote cannot name its organization', async () => {
  // The account read that names the session's organization fails.
  const { client, calls, close } = await connect('claude-ai', { accountDown: true });
  try {
    const priced = { model: 'sync-3', duration: 222, workflow: 'translate-and-dub' };
    const quote = await client.callTool({
      name: 'generations_estimate-cost',
      arguments: {
        ...priced,
        create: {
          tool: 'dubbing_create',
          arguments: { videoAssetId: 'video-1', targetLang: 'de' },
        },
      },
    });
    // The price still stands, but a call without its organization would run wherever the
    // session is when the button is pressed, so the card gets none and asks the chat.
    expect(quote.structuredContent).toMatchObject({ estimatedCredits: 84, request: priced });
    expect(quote.structuredContent).not.toHaveProperty('create');
    expect(calls.some((call) => call.path === '/v2/account')).toBe(true);
  } finally {
    await close();
  }
});

it.each(['openai-mcp', 'openai-mcp (codex)', 'cursor-vscode'])(
  'offers %s a quote without a create call, so its card asks the chat to create',
  async (clientName) => {
    const { client, close } = await connect(clientName);
    try {
      const { tools } = await client.listTools();
      const estimate = tools.find((tool) => tool.name === 'generations_estimate-cost')!;
      // OpenAI's app review refuses a tool whose input names another tool and its arguments.
      expect(estimate.inputSchema.properties).toHaveProperty('duration');
      expect(estimate.inputSchema.properties).not.toHaveProperty('create');
      // A call that names one anyway is priced like any other and carries none back.
      const quote = await client.callTool({
        name: estimate.name,
        arguments: {
          model: 'sync-3',
          duration: 222,
          create: { tool: 'dubbing_create', arguments: { videoAssetId: 'video-1' } },
        },
      });
      expect(quote.structuredContent).toMatchObject({
        estimatedCredits: 84,
        request: { model: 'sync-3', duration: 222 },
      });
      expect(quote.structuredContent).not.toHaveProperty('create');
    } finally {
      await close();
    }
  },
);

it('refuses a quote whose create call uses a project the person did not choose', async () => {
  const { client, calls, close } = await connect('claude-ai');
  try {
    const project = {
      videoAssetId: 'video-1',
      audioAssetId: 'audio-1',
      projectId: '00000000-0000-4000-8000-000000000009',
    };
    const quote = (args: Record<string, unknown>) =>
      client.callTool({
        name: 'generations_estimate-cost',
        arguments: {
          model: 'sync-3',
          duration: 222,
          create: { tool: 'lipsync_create', arguments: args },
        },
      });
    const unchosen = await quote(project);
    expect(unchosen.isError).toBe(true);
    expect(JSON.stringify(unchosen.content)).toContain(
      'Existing project use requires an explicit user selection',
    );
    expect(calls.some((call) => call.path === '/v2/generate/estimate-cost')).toBe(false);
    // With the choice, the call goes back whole: lipsync_create checks the choice again.
    const chosen = await quote({ ...project, projectIntent: 'explicit' });
    expect((chosen.structuredContent as { create: unknown }).create).toEqual({
      tool: 'lipsync_create',
      arguments: {
        ...project,
        projectIntent: 'explicit',
        model: 'sync-3',
        organizationId: ORGANIZATION,
      },
      idempotencyKey: expect.stringMatching(UUID),
    });
  } finally {
    await close();
  }
});

it('opens a shot review only on a finished generation whose shots cover the whole video', async () => {
  const { client, calls, close } = await connect('claude-ai');
  try {
    const review = (shots: { startFrame: number; endFrame: number }[]) =>
      client.callTool({
        name: 'shots_review',
        arguments: { generationId: GENERATION, shots, fps: 24, frameCount: 96 },
      });
    // A gap would leave frames the person could never flag.
    const gap = await review([
      { startFrame: 0, endFrame: 40 },
      { startFrame: 48, endFrame: 96 },
    ]);
    expect(gap.isError).toBe(true);
    expect(JSON.stringify(gap.content)).toContain('shots[1] must start at frame 40');
    expect(calls.some((call) => call.path.startsWith('/v2/generate/'))).toBe(false);

    const shots = [
      { startFrame: 0, endFrame: 40 },
      { startFrame: 40, endFrame: 96 },
    ];
    const opened = await review(shots);
    expect(opened.structuredContent).toEqual({
      reviewId: expect.any(String),
      generationId: GENERATION,
      title: 'Keynote in German',
      videoUrl: 'https://fixture.invalid/result.mp4',
      sourceUrl: 'https://fixture.invalid/source.mp4',
      fps: 24,
      frameCount: 96,
      shots,
    });
    // A generation whose shots cannot be rendered again is refused with the way to redo
    // it, before anyone flags a shot.
    const timeline = await client.callTool({
      name: 'shots_review',
      arguments: { generationId: TIMELINE, shots, fps: 24, frameCount: 96 },
    });
    expect(timeline.isError).toBe(true);
    expect(JSON.stringify(timeline.content)).toContain('lipsync_create-timeline');

    // Reading is all it does: the card's buttons start the render and the final build.
    expect(
      calls.filter((call) => call.path.startsWith('/v2/generate')).map((call) => call.path),
    ).toEqual([`/v2/generate/${GENERATION}`, `/v2/generate/${TIMELINE}`]);
  } finally {
    await close();
  }
});
