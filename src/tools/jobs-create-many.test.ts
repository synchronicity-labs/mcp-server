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
  remaining?: unknown;
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

function setup(
  respond: (args: Record<string, unknown>, attempt: number) => Promise<unknown>,
  options: { concurrency?: number; launchWindowMs?: number } = {},
) {
  const http: HttpClient = {
    request: vi.fn(async () =>
      options.concurrency === undefined
        ? {}
        : { limits: { concurrency: options.concurrency, maxOutputDurationSeconds: 60 } },
    ),
  };
  const [tool] = createJobsCreateManyTool([dubbing], [dubbing], http, {
    launchWindowMs: options.launchWindowMs ?? 5_000,
  });
  const attempts = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    const attempt = (attempts.get(String(args.targetLang)) ?? 0) + 1;
    attempts.set(String(args.targetLang), attempt);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await respond(args, attempt);
    } finally {
      inFlight -= 1;
    }
  });
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
  it('offers only the create tools this connection lists', () => {
    const http = { request: vi.fn() };
    expect(createJobsCreateManyTool([], [dubbing], http)).toEqual([]);
    const [tool] = createJobsCreateManyTool([dubbing], [dubbing], http);
    expect((tool!.inputSchema.tool as z.ZodEnum).options).toEqual(['dubbing_create']);
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
      { concurrency: 2, launchWindowMs: 200 },
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
      throw new ApiRequestError('No credits', 402, 'insufficient_credits');
    });
    const result = await run({ items: items('es', 'fr', 'ja', 'de') });
    // Unknown concurrency starts two at a time; both refusals arrive before anything else.
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(result.summary).toMatchObject({ failed: 2, notStarted: 2 });
    expect(result.nextStep).toContain('Stopped after No credits');
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
    await expect(run({ items: items('es') })).rejects.toThrow('at least 2 items');
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
});
