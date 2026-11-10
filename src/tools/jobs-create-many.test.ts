import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import type { McpToolDefinition, ToolRequestContext } from './generator.js';
import { createJobsCreateManyTool } from './jobs-create-many.js';

// jobs_create-many's scheduling: items run through context.callTool, the account's
// concurrency limit caps what is in flight, and capacity refusals are waited out.
type Result = {
  summary: Record<string, number>;
  items: { index: number; status: string; id?: string; error?: Record<string, unknown> }[];
  jobs: { kind: string; id: string }[];
  remaining?: { tool: string; idempotencyKey: string; items: Record<string, unknown>[] };
  nextStep: string;
};
const setKey = '6f1f8c63-41a4-4f55-9d4e-2f7c1f7b1f10';
const projectId = '00000000-0000-4000-8000-000000000001';

const dubbing: McpToolDefinition = {
  name: 'dubbing_create',
  description: 'dub',
  inputSchema: {
    videoAssetId: z.string(),
    targetLang: z.string(),
    projectId: z.string().optional(),
    projectCreationKey: z.uuid().optional(),
    idempotencyKey: z.string().optional(),
  },
  handler: async () => {
    throw new Error('runs only through callTool');
  },
};
const items = (...langs: string[]) =>
  langs.map((targetLang) => ({ videoAssetId: 'v-1', targetLang }));
const busy = (ms: number) =>
  new ApiRequestError('API request failed: 429', 429, 'concurrency_limit_reached', ms);

type Respond = (
  args: Record<string, unknown>,
  attempt: number,
  signal: AbortSignal | undefined,
) => Promise<unknown>;

/** Settles only when the signal aborts, like a request the API never answers. */
const hang = (signal: AbortSignal | undefined) =>
  new Promise<never>((_resolve, reject) =>
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );

function setup(
  respond: Respond,
  options: {
    concurrency?: number;
    budgetMs?: number;
    requestMs?: number;
    account?: (signal?: AbortSignal) => Promise<unknown>;
  } = {},
) {
  const http: HttpClient = {
    request: vi.fn(async (_method, _path, request) =>
      options.account
        ? options.account(request?.signal)
        : options.concurrency === undefined
          ? {}
          : { limits: { concurrency: options.concurrency, maxOutputDurationSeconds: 60 } },
    ),
  };
  const [tool] = createJobsCreateManyTool([dubbing], http, {
    budgetMs: options.budgetMs ?? 5_000,
    requestMs: options.requestMs ?? 0,
  });
  const attempts = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const callTool = vi.fn(
    async (_name: string, args: Record<string, unknown>, nested: { signal?: AbortSignal }) => {
      const attempt = (attempts.get(String(args.targetLang)) ?? 0) + 1;
      attempts.set(String(args.targetLang), attempt);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await respond(args, attempt, nested.signal);
      } finally {
        inFlight -= 1;
      }
    },
  );
  const progress = vi.fn(async (_progress: number, _message?: string) => {});
  const run = (args: Record<string, unknown>) =>
    tool!.handler({ tool: 'dubbing_create', idempotencyKey: setKey, ...args }, {
      callTool,
      progress,
    } as ToolRequestContext) as Promise<Result>;
  return { tool: tool!, run, callTool, progress, maxInFlight: () => maxInFlight };
}

const started = async (args: Record<string, unknown>) => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { id: `g-${String(args.targetLang)}`, status: 'PENDING' };
};

describe('jobs_create-many', () => {
  it('offers only listed create tools whose requests carry a key', () => {
    const http = { request: vi.fn() };
    expect(createJobsCreateManyTool([], http)).toEqual([]);
    const preview = { ...dubbing, name: 'dialogue-previews_create' };
    // A generated create without an admission key could bill twice on a resend.
    const unkeyed = { ...dubbing, name: 'generations_create', inputSchema: { model: z.string() } };
    const offered = (keyedDialoguePreviews?: boolean) => {
      const [tool] = createJobsCreateManyTool([dubbing, preview, unkeyed], http, {
        keyedDialoguePreviews,
      });
      return (tool!.inputSchema.tool as z.ZodEnum).options;
    };
    expect(offered()).toEqual(['dubbing_create']);
    expect(offered(false)).toEqual(['dubbing_create']);
    expect(offered(true)).toEqual(['dubbing_create', 'dialogue-previews_create']);
    const [tool] = createJobsCreateManyTool([dubbing], http);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('keeps at most the account concurrency in flight and reports every job in order', async () => {
    const { run, maxInFlight, progress } = setup(started, { concurrency: 2 });
    const result = await run({ items: items('es', 'fr', 'ja', 'de', 'it') });
    expect(maxInFlight()).toBe(2);
    expect(result.summary).toEqual({ total: 5, started: 5, failed: 0, notStarted: 0 });
    expect(result.items.map((item) => item.id)).toEqual(['g-es', 'g-fr', 'g-ja', 'g-de', 'g-it']);
    expect(result.jobs[0]).toEqual({ kind: 'generation', id: 'g-es' });
    expect(result.remaining).toBeUndefined();
    expect(result.nextStep).toContain('jobs_get-many');
    expect(progress.mock.calls.at(-1)?.[1]).toBe('5 of 5 started');
  });

  it('waits out concurrency_limit_reached and resends the same keyed request', async () => {
    const { run, callTool } = setup(
      async (args, attempt) => {
        if (args.targetLang === 'fr' && attempt === 1) throw busy(5);
        return started(args);
      },
      { concurrency: 3 },
    );
    const result = await run({ items: items('es', 'fr', 'ja') });
    expect(result.summary).toMatchObject({ started: 3, notStarted: 0 });
    const fr = callTool.mock.calls.filter(([, args]) => args.targetLang === 'fr');
    expect(fr).toHaveLength(2);
    expect(fr[1]![1]).toEqual(fr[0]![1]);
    expect(fr[0]![1].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // The others were sent once each.
    expect(callTool).toHaveBeenCalledTimes(4);
  });

  it('returns within its launch window, with the items it could not start as remaining', async () => {
    const { run, callTool } = setup(
      async (args) => {
        if (args.targetLang === 'es') return started(args);
        throw busy(60_000);
      },
      { concurrency: 2, budgetMs: 400, requestMs: 200 },
    );
    const began = Date.now();
    const list = items('es', 'fr', 'ja', 'de');
    const result = await run({ items: list });
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(result.items.map((item) => item.status)).toEqual([
      'started',
      'not_started',
      'not_started',
      'not_started',
    ]);
    expect(result.items[1]!.error).toMatchObject({
      status: 429,
      code: 'concurrency_limit_reached',
    });
    // While the account is busy, nothing else is sent.
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(result.remaining).toEqual({
      tool: 'dubbing_create',
      idempotencyKey: setKey,
      items: list.slice(1),
    });
    expect(result.nextStep).toContain('concurrent generation limit');
  });

  it('reports a failed item without failing the others', async () => {
    const { run } = setup(
      async (args) => {
        if (args.targetLang === 'fr') throw new ApiRequestError('bad video', 422, 'invalid_input');
        return started(args);
      },
      { concurrency: 3 },
    );
    const result = await run({ items: items('es', 'fr', 'ja') });
    expect(result.summary).toEqual({ total: 3, started: 2, failed: 1, notStarted: 0 });
    expect(result.items[1]).toEqual({
      index: 1,
      status: 'failed',
      kind: 'generation',
      error: { message: 'bad video', status: 422, code: 'invalid_input' },
    });
    expect(result.jobs.map((job) => job.id)).toEqual(['g-es', 'g-ja']);
  });

  it('stops starting items after a billing refusal', async () => {
    const { run, callTool } = setup(async () => {
      const nextAction = { type: 'buy_credits', url: 'https://sync.so/billing' };
      throw new ApiRequestError(
        'No credits',
        402,
        'insufficient_credits',
        undefined,
        undefined,
        undefined,
        { nextAction, requiredCredits: 800, billingUrl: 'https://sync.so/billing' },
      );
    });
    const result = await run({ items: items('es', 'fr', 'ja', 'de') });
    // Unknown concurrency starts two at a time; both refusals arrive before anything else.
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(result.summary).toMatchObject({ failed: 2, notStarted: 2 });
    expect(result.nextStep).toContain('Stopped after No credits');
    expect(result.items[0]?.error).toMatchObject({
      nextAction: { type: 'buy_credits', url: 'https://sync.so/billing' },
      requiredCredits: 800,
      billingUrl: 'https://sync.so/billing',
    });
  });

  it('refuses invalid or repeated items before starting any', async () => {
    const { run, callTool } = setup(started);
    await expect(
      run({
        items: [...items('es', 'fr'), { videoAssetId: 'v-1', targetLang: 5 }, ...items('es')],
      }),
    ).rejects.toThrow(
      /Nothing was started\. items\[2\]\.targetLang: .*; items\[3\] repeats items\[0\]/,
    );
    await expect(run({ items: [] })).rejects.toThrow('at least one item');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('derives stable keys from the set key and item, keeping keys the item sets', async () => {
    const { run, callTool } = setup(started, { concurrency: 5 });
    const list = [
      { videoAssetId: 'v-1', targetLang: 'es' },
      { videoAssetId: 'v-1', targetLang: 'fr', idempotencyKey: 'mine' },
      { videoAssetId: 'v-1', targetLang: 'ja', projectId, projectIntent: 'explicit' },
    ];
    await run({ items: list });
    await run({ items: [list[2]!, list[1]!, list[0]!] });
    const sent = (lang: string) =>
      callTool.mock.calls.filter(([, args]) => args.targetLang === lang).map(([, args]) => args);
    const [first, again] = sent('es');
    expect(again).toEqual(first);
    expect(first!.projectCreationKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(first!.projectCreationKey).not.toBe(first!.idempotencyKey);
    expect(sent('fr')[0]).toMatchObject({ idempotencyKey: 'mine' });
    // An item in an explicit project gets no new-project key.
    expect(sent('ja')[0]).not.toHaveProperty('projectCreationKey');
    // Another set key derives other keys for the same item.
    const other = await setup(started).tool.handler(
      {
        tool: 'dubbing_create',
        idempotencyKey: '00000000-0000-4000-8000-0000000000aa',
        items: list,
      },
      { callTool } as ToolRequestContext,
    );
    expect(other).toMatchObject({ summary: { started: 3 } });
    expect(sent('es')[2]!.idempotencyKey).not.toBe(first!.idempotencyKey);
  });

  it('resumes from remaining, down to a single item, with the keys of the original call', async () => {
    const { run, callTool } = setup(
      async (args, attempt) => {
        if (args.targetLang === 'fr' && attempt === 1) throw busy(60_000);
        return started(args);
      },
      { concurrency: 1, budgetMs: 400, requestMs: 200 },
    );
    const first = await run({ items: items('es', 'fr', 'ja') });
    expect(first.summary).toMatchObject({ started: 1, notStarted: 2 });
    const second = await run(first.remaining!);
    expect(second.summary).toMatchObject({ total: 2, started: 2 });
    // The last item alone is accepted too.
    const third = await run({ ...first.remaining!, items: [first.remaining!.items[1]!] });
    expect(third.summary).toEqual({ total: 1, started: 1, failed: 0, notStarted: 0 });
    const keys = (lang: string) =>
      callTool.mock.calls
        .filter(([, args]) => args.targetLang === lang)
        .map(([, args]) => [args.idempotencyKey, args.projectCreationKey]);
    // fr's refused attempt in the first call and its start in the second share keys.
    expect(keys('fr')).toHaveLength(2);
    expect(new Set(keys('fr').map((pair) => pair.join()))).toHaveLength(1);
    expect(keys('ja')).toHaveLength(2);
    expect(new Set(keys('ja').map((pair) => pair.join()))).toHaveLength(1);
    expect(keys('ja')[0]).not.toEqual(keys('fr')[0]);
  });

  it('reports a request cut off at the deadline as failed with an unknown outcome', async () => {
    const { run } = setup(
      async (args, _attempt, signal) => {
        if (args.targetLang === 'fr') return hang(signal);
        if (args.targetLang === 'ja')
          throw new ApiRequestError('Outcome unknown', 503, 'IDEMPOTENCY_OUTCOME_UNKNOWN');
        return started(args);
      },
      { concurrency: 3, budgetMs: 300, requestMs: 100 },
    );
    const began = Date.now();
    const list = items('es', 'fr', 'ja');
    const result = await run({ items: list });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(result.items.map((item) => item.status)).toEqual(['started', 'failed', 'failed']);
    expect(result.items[1]!.error).toMatchObject({ code: 'outcome_unknown', outcomeUnknown: true });
    expect(result.items[2]!.error).toMatchObject({ status: 503, outcomeUnknown: true });
    expect(result.remaining?.items).toEqual(list.slice(1));
    expect(result.nextStep).toContain('outcomeUnknown may have started');
  });

  it('counts the account lookup against the same deadline', async () => {
    const { run, callTool } = setup(started, {
      budgetMs: 300,
      requestMs: 100,
      account: hang,
    });
    const began = Date.now();
    const result = await run({ items: items('es', 'fr') });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(result.summary).toMatchObject({ notStarted: 2 });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('treats a reply cut off mid-body as an unknown outcome, not a refusal', async () => {
    const { run } = setup(
      async (args) => {
        if (args.targetLang === 'fr') throw new TypeError('terminated');
        return started(args);
      },
      { concurrency: 2 },
    );
    const list = items('es', 'fr');
    const result = await run({ items: list });
    expect(result.items.map((item) => item.status)).toEqual(['started', 'failed']);
    expect(result.items[1]!.error).toMatchObject({ outcomeUnknown: true });
    expect(result.remaining?.items).toEqual(list.slice(1));
  });
});
