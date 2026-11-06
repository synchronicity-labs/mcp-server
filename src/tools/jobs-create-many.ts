import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import type { McpToolDefinition, ToolRequestContext } from './generator.js';
import type { AnyJobKind } from './job-status.js';
import { sleep, WAIT_BUDGET_MS } from './job-wait.js';
import { checkItems, created, isRecord, withKeys } from './jobs-create-many-items.js';
import { MAX_JOBS } from './jobs-get-many.js';
import { parseAccountOverview } from './organizations.js';

/**
 * jobs_create-many: start several independent jobs by calling one create tool once per item,
 * through the same path, limits and billing as separate calls. Each item runs through
 * context.callTool, so the server applies every check a direct call gets. It keeps at most
 * the account's concurrent generation limit in flight, waits out capacity refusals and
 * resends the same keyed request, and returns once every item was started or given up on,
 * within the wait budget, never waiting for the jobs themselves to finish.
 */

const MIN_ITEMS = 2;
// More than this many requests in flight only queues uploads in one server process.
const MAX_IN_FLIGHT = 10;
// When the plan's limit cannot be read, start slowly; capacity refusals cover the rest.
const UNKNOWN_IN_FLIGHT = 2;
// The API's own Retry-After for concurrency_limit_reached is 20 seconds.
const BUSY_RETRY_MS = 20_000;
const PREPARING_RETRY_MS = 2_000;
// Never resend sooner than this, even when the API says Retry-After: 0.
const MIN_RETRY_MS = 1_000;
// No new attempt starts after this, so a request started late still returns in the budget.
const LAUNCH_WINDOW_MS = WAIT_BUDGET_MS - 10_000;

type CreateSpec = { kind: AnyJobKind; reads?: ('projectId' | 'videoAssetId')[] };

/** The create tools this can run, and which job kind (and read fields) each one starts. */
const CREATE_TOOLS: Record<string, CreateSpec> = {
  lipsync_create: { kind: 'generation' },
  'lipsync_create-timeline': { kind: 'generation' },
  dubbing_create: { kind: 'generation' },
  'dialogue-videos_create': { kind: 'generation' },
  generations_create: { kind: 'generation' },
  'translation-previews_create': { kind: 'translation_preview', reads: ['projectId'] },
  'dialogue-previews_create': {
    kind: 'dialogue_preview',
    reads: ['projectId', 'videoAssetId'],
  },
  'speech-previews_create': { kind: 'speech_preview', reads: ['projectId'] },
};

type ItemError = {
  message: string;
  status?: number;
  code?: string;
  retryAfterMs?: number;
  generationId?: string;
};
type Job = { kind: AnyJobKind; id: string; projectId?: string; videoAssetId?: string };
type Started = { kind: AnyJobKind; id?: string; job?: Job };
type Outcome = { index: number } & (
  | ({ status: 'started' } & Started)
  | { status: 'failed'; error: ItemError }
  | { status: 'not_started'; error?: ItemError }
);

export type CreateManyOptions = { launchWindowMs?: number };

function itemError(error: unknown): ItemError {
  if (error instanceof ApiRequestError)
    return {
      message: error.message,
      status: error.status,
      ...(error.code ? { code: error.code } : {}),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.generationId ? { generationId: error.generationId } : {}),
    };
  if (error instanceof z.ZodError) return { message: z.prettifyError(error) };
  return { message: error instanceof Error ? error.message : String(error) };
}

/**
 * How long to wait before sending the same request again, when the API refused it before
 * admitting anything: the account is at capacity (429), or this key's earlier attempt or a
 * linked import is still preparing (409). Any other error is the item's result.
 */
function retryAfter(error: unknown): { ms: number; accountBusy: boolean } | undefined {
  if (!(error instanceof ApiRequestError)) return undefined;
  const ms = (fallback: number) => Math.max(error.retryAfterMs ?? fallback, MIN_RETRY_MS);
  if (error.status === 429) return { ms: ms(BUSY_RETRY_MS), accountBusy: true };
  if (
    error.status === 409 &&
    (error.code === 'IDEMPOTENCY_IN_PROGRESS' || error.code === 'import_in_progress')
  )
    return { ms: ms(PREPARING_RETRY_MS), accountBusy: false };
  return undefined;
}

// Authentication and billing refusals would refuse every other item the same way.
const stopsTheSet = (error: unknown) =>
  error instanceof ApiRequestError && (error.status === 401 || error.status === 402);

async function inFlightLimit(http: HttpClient, items: number, signal?: AbortSignal) {
  let concurrency: number | undefined;
  try {
    concurrency = parseAccountOverview(await http.request('get', '/v2/account', { signal })).limits
      ?.concurrency;
  } catch {
    signal?.throwIfAborted();
  }
  const limit = concurrency === undefined ? UNKNOWN_IN_FLIGHT : Math.max(1, concurrency);
  return Math.min(limit, MAX_IN_FLIGHT, items);
}

function nextStep(outcomes: Outcome[], halted: unknown): string {
  const count = (status: Outcome['status']) => outcomes.filter((o) => o.status === status).length;
  const steps: string[] = [];
  if (count('started') > 0)
    steps.push(
      'Follow the started jobs with jobs_get-many, passing jobs (wait: true to wait on the server); never start them again.',
    );
  if (count('not_started') > 0)
    steps.push(
      halted
        ? `Stopped after ${itemError(halted).message}; fix that, then call jobs_create-many again with remaining.`
        : 'The account stayed at its concurrent generation limit, so remaining items were not started. Once jobs_get-many shows running jobs finishing, call jobs_create-many again with remaining (the same tool, idempotencyKey and items); keys make that safe.',
    );
  if (count('failed') > 0)
    steps.push(
      'A failed item with a 5xx or no status may still have started: send that item again with the same idempotencyKey, which never creates it twice. Fix other failed items before sending them again.',
    );
  return steps.join(' ');
}

type Run = {
  call: (index: number) => Promise<Started>;
  limit: number;
  items: number;
  options: Required<CreateManyOptions>;
  signal?: AbortSignal;
  progress: (outcomes: Outcome[], waiting: boolean) => Promise<void>;
};

/** Runs the items with at most `limit` in flight; returns each outcome and any stop. */
async function runItems({ call, limit, items, options, signal, progress }: Run) {
  const launchBy = Date.now() + options.launchWindowMs;
  const outcomes: Outcome[] = [];
  // Shared by every worker: when the account has capacity again, and what stopped the set.
  const shared: { busyUntil: number; halted?: unknown; next: number } = { busyUntil: 0, next: 0 };

  const attempt = async (index: number): Promise<Outcome> => {
    let readyAt = 0;
    let waitedOn: ItemError | undefined;
    for (;;) {
      const at = Math.max(shared.busyUntil, readyAt);
      if (shared.halted || at > launchBy)
        return { index, status: 'not_started', ...(waitedOn ? { error: waitedOn } : {}) };
      if (at > Date.now()) {
        await progress(outcomes, true);
        await sleep(at - Date.now(), signal);
        continue;
      }
      try {
        return { index, status: 'started', ...(await call(index)) };
      } catch (error) {
        signal?.throwIfAborted();
        const wait = retryAfter(error);
        if (!wait) {
          if (stopsTheSet(error)) shared.halted ??= error;
          return { index, status: 'failed', error: itemError(error) };
        }
        waitedOn = itemError(error);
        if (wait.accountBusy) shared.busyUntil = Math.max(shared.busyUntil, Date.now() + wait.ms);
        else readyAt = Date.now() + wait.ms;
      }
    }
  };
  const worker = async () => {
    while (shared.next < items && !shared.halted && Date.now() <= launchBy) {
      const index = shared.next++;
      outcomes[index] = await attempt(index);
      await progress(outcomes, false);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  for (let index = 0; index < items; index++) outcomes[index] ??= { index, status: 'not_started' };
  return { outcomes, halted: shared.halted };
}

export function createJobsCreateManyTool(
  listed: McpToolDefinition[],
  all: McpToolDefinition[],
  http: HttpClient,
  overrides: CreateManyOptions = {},
): McpToolDefinition[] {
  const targets = listed.filter((tool) => tool.name in CREATE_TOOLS);
  if (targets.length === 0) return [];
  const names = targets.map((tool) => tool.name) as [string, ...string[]];
  const runOptions = { launchWindowMs: LAUNCH_WINDOW_MS, ...overrides };
  const dialogueOptions = all.find((tool) => tool.name === 'dialogue_get-options');
  const input = z
    .object({
      tool: z
        .enum(names)
        .describe('The create tool to run once per item. Other tools cannot run this way.'),
      idempotencyKey: z
        .uuid()
        .describe(
          'A fresh UUID for this approved set, saved before the call. Reuse it unchanged, with the same items, when calling again for remaining or uncertain items; each item derives its own keys from it.',
        ),
      items: z
        .array(z.record(z.string(), z.unknown()))
        .min(MIN_ITEMS, `Pass at least ${MIN_ITEMS} items; for one job, call the tool itself.`)
        .max(MAX_JOBS, `Pass at most ${MAX_JOBS} items; split a larger set into several calls.`)
        .describe(
          `${MIN_ITEMS} to ${MAX_JOBS} items, each exactly the arguments tool takes on its own, such as one dubbing_create input per target language. Items must differ.`,
        ),
    })
    .strict();
  const error = z
    .object({
      message: z.string(),
      status: z.number().optional(),
      code: z.string().optional(),
      retryAfterMs: z.number().optional(),
      generationId: z.string().optional(),
    })
    .describe('Why the item failed, or the last refusal it waited on.');
  const job = z.object({
    kind: z.string(),
    id: z.string(),
    projectId: z.string().optional(),
    videoAssetId: z.string().optional(),
  });

  const description =
    `Start ${MIN_ITEMS} to ${MAX_JOBS} independent Sync jobs at once by running one create tool once per item: ${names.join(', ')}. ` +
    'Use it whenever the user wants 2 or more jobs that do not depend on each other, such as one video lip-synced to several audios, one video dubbed into several languages (one dubbing_create item per language, when available), or one Edit Dialogue preview, then one video, per variant. ' +
    'It works on every plan and uses the same API, limits and billing as calling the tool once per item; it is not the batch API. ' +
    'Each item is that tool’s own arguments and is checked as a direct call would be; nothing starts if any item is invalid or repeats another. ' +
    'This is a paid action: every item is billed as its own job. Before calling, estimate each distinct configuration with the matching estimate tool, tell the user the item count and the estimated total, and wait for one confirmation of the whole set. ' +
    'Items without projectId each get a new project; to keep the set together, create one project with projects_create and pass its projectId with projectIntent=explicit in every item. ' +
    'It keeps at most the account’s concurrent generation limit in flight and waits out capacity refusals, resending the same keyed request, then returns within about 50 seconds without waiting for the jobs to finish. ' +
    'Each item comes back started (with kind and id), failed (with error) or not_started (the account stayed busy). Pass jobs to jobs_get-many to follow them; when remaining is present, call again later with remaining, which reuses the same keys and so never starts a job twice.';

  return [
    {
      name: 'jobs_create-many',
      title: 'Start many Sync jobs',
      description,
      inputSchema: input.shape,
      outputSchema: {
        tool: z.string().describe('The create tool that ran.'),
        summary: z
          .object({
            total: z.number(),
            started: z.number(),
            failed: z.number(),
            notStarted: z.number(),
          })
          .describe('How many items ended in each status.'),
        items: z
          .array(
            z.object({
              index: z.number().describe('The item’s position in items.'),
              status: z.enum(['started', 'failed', 'not_started']),
              kind: z.string().optional().describe('The job kind, for jobs_get-many.'),
              id: z.string().optional().describe('The started job’s id.'),
              error: error.optional(),
            }),
          )
          .describe('One result per item, in input order.'),
        jobs: z.array(job).describe('The started jobs, ready to pass as jobs to jobs_get-many.'),
        remaining: z
          .object({
            tool: z.string(),
            idempotencyKey: z.string(),
            items: z.array(z.record(z.string(), z.unknown())),
          })
          .optional()
          .describe('The items not started, as passed; send them again later as they are.'),
        nextStep: z.string().describe('What to do next.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (args, context?: ToolRequestContext) => {
        const request = input.parse(args);
        const callTool = context?.callTool;
        if (!callTool) throw new Error('jobs_create-many runs only inside a Sync MCP session.');
        const target = targets.find((candidate) => candidate.name === request.tool)!;
        const spec = CREATE_TOOLS[request.tool]!;
        const signal = context?.signal;
        const preview = request.tool === 'dialogue-previews_create';
        const options = preview ? await dialogueOptions?.handler({}, context) : undefined;
        const keyedPreview = !preview || (isRecord(options) && options.keyedPreview === true);
        // Keys first, so a tool that requires one accepts the item as the agent sent it.
        const calls = checkItems(
          target,
          request.items.map((item) => withKeys(target, request.idempotencyKey, item, keyedPreview)),
        );
        const limit = await inFlightLimit(http, calls.length, signal);
        const call = async (index: number) => {
          const item = calls[index]!;
          const result = created(await callTool(request.tool, item, { signal }));
          const id = typeof result.id === 'string' ? result.id : undefined;
          const reads = Object.fromEntries(
            (spec.reads ?? []).flatMap((field) =>
              typeof item[field] === 'string' ? [[field, item[field]]] : [],
            ),
          );
          return { kind: spec.kind, id, ...(id ? { job: { kind: spec.kind, id, ...reads } } : {}) };
        };
        const progress = async (outcomes: Outcome[], waiting: boolean) => {
          const done = outcomes.filter(Boolean);
          const started = done.filter((outcome) => outcome.status === 'started').length;
          await context?.progress?.(
            done.length,
            `${started} of ${calls.length} started${waiting ? ', waiting for free capacity' : ''}`,
          );
        };
        const { outcomes, halted } = await runItems({
          call,
          limit,
          items: calls.length,
          options: runOptions,
          signal,
          progress,
        });
        const notStarted = outcomes.filter((outcome) => outcome.status === 'not_started');
        return {
          tool: request.tool,
          summary: {
            total: outcomes.length,
            started: outcomes.filter((outcome) => outcome.status === 'started').length,
            failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
            notStarted: notStarted.length,
          },
          items: outcomes.map(({ job: _job, ...outcome }: Outcome & { job?: Job }) => ({
            ...outcome,
            kind: spec.kind,
          })),
          jobs: outcomes.flatMap((outcome) =>
            outcome.status === 'started' && outcome.job ? [outcome.job] : [],
          ),
          ...(notStarted.length > 0
            ? {
                remaining: {
                  tool: request.tool,
                  idempotencyKey: request.idempotencyKey,
                  items: notStarted.map((outcome) => request.items[outcome.index]!),
                },
              }
            : {}),
          nextStep: nextStep(outcomes, halted),
        };
      },
    },
  ];
}
