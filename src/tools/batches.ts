import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import { BATCH_DONE, resultRow, withResults } from './batch-results.js';
import type { McpToolDefinition, ToolRequestContext } from './generator.js';
import { pollUntil, waitInput } from './job-wait.js';
import { projectIntentError, projectUseAllowed } from './project-intent.js';

/**
 * batches_create, batches_get and batches_list: many independent /v2/generate generations
 * as one Sync batch. batches_create builds the API's JSON `rows` form and checks locally
 * what the API would refuse anyway, naming the item. batches_get adds each row's result
 * from batch-results.ts once the batch finishes.
 */

export const BATCH_TOOLS = ['batches_create', 'batches_get', 'batches_list'] as const;

const MIN_ITEMS = 20;
// The API measures the rows as JSONL, one compact JSON object per line.
const MAX_JSONL_BYTES = 5 * 1024 * 1024;
const LIST_STATUSES = ['PENDING', 'JOBS_CREATED', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;
const MAX_REPORTED_PROBLEMS = 10;

const BATCH_ROUTES = ['post /v2/batch', 'get /v2/batch', 'get /v2/batch/{id}'];

export function isBatchOperation(operation: ParsedOperation): boolean {
  return BATCH_ROUTES.includes(`${operation.method} ${operation.path}`);
}

function supportsBatches(operations: ParsedOperation[]): boolean {
  return BATCH_ROUTES.every((route) =>
    operations.some((operation) => `${operation.method} ${operation.path}` === route),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const item = z
  .object({
    requestId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Your id for this item, unique in the batch. Omit it to get item-<n> (n counts from 1). Each result row carries it.',
      ),
    payload: z
      .record(z.string(), z.unknown())
      .describe(
        'One POST /v2/generate body, the same as a single generation: {model, input: [{type: "video", url}, {type: "audio", url}], options?}. Input items take a public URL or a Sync assetId; a text input takes {type: "text", provider: {...}} with a voice from voices_list.',
      ),
  })
  .strict();

const createInput = z
  .object({
    items: z
      .array(item)
      .min(
        MIN_ITEMS,
        `A batch needs at least ${MIN_ITEMS} items; create fewer generations one at a time.`,
      )
      .describe(
        `The generations, in order; at least ${MIN_ITEMS}. Plans allow up to 500 per batch by default, and the whole batch must fit in 5 MB as JSONL.`,
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        'Validate every item with the API without creating the batch or spending anything; answers status VALIDATED.',
      ),
    webhookUrl: z
      .url()
      .optional()
      .describe(
        'URL Sync POSTs the batch to when it finishes, signed with the organization webhook secret.',
      ),
    projectIntent: z
      .literal('explicit')
      .optional()
      .describe(
        'Required when any payload sets projectId. Set only when the user explicitly chose that project, or it is the project just created for this request; never infer it from a matching name or an open editor.',
      ),
  })
  .strict();

/** Items writing into an existing project need the same explicit intent as every write tool. */
function assertProjectIntent(
  items: z.infer<typeof item>[],
  projectIntent: 'explicit' | undefined,
): void {
  const refused = items.flatMap(({ payload }, index) =>
    projectUseAllowed(payload.projectId, projectIntent) ? [] : [`items[${index}]`],
  );
  if (refused.length === 0) return;
  const named = refused.slice(0, MAX_REPORTED_PROBLEMS).join(', ');
  const more =
    refused.length > MAX_REPORTED_PROBLEMS
      ? ` and ${refused.length - MAX_REPORTED_PROBLEMS} more`
      : '';
  throw projectIntentError(
    `The batch was not sent: ${named}${more} set payload.projectId without projectIntent=explicit. `,
  );
}

const metrics = z
  .looseObject({
    total_generations: z.number().optional(),
    success_count: z.number().optional(),
    failed_count: z.number().optional(),
    pending_count: z.number().optional(),
  })
  .describe('Generation counts: total, succeeded, failed and still pending.');

const batchFields = {
  id: z.string().describe('The batch id; pass it to batches_get.'),
  status: z
    .string()
    .describe(
      'PENDING, JOBS_CREATED or PROCESSING while running (internal states also mean running); COMPLETED or FAILED when done.',
    ),
  created_at: z.string().optional(),
  metrics: metrics.optional(),
  webhookUrl: z.string().nullable().optional(),
  outputUrl: z
    .string()
    .nullable()
    .optional()
    .describe('The JSONL result file once the batch finishes; empty while it runs.'),
};

const createOutput = {
  ...batchFields,
  id: batchFields.id.optional(),
  requestIds: z
    .array(z.string())
    .describe('Each item’s requestId, in item order, including generated ones.'),
};

const getInput = z
  .object({
    id: z.string().trim().min(1).describe('The batch id batches_create or batches_list returned.'),
    wait: waitInput,
    results: z
      .enum(['all', 'failed', 'none'])
      .optional()
      .describe(
        'Once the batch finishes, which result rows to return: all (default), failed (FAILED or REJECTED only) or none.',
      ),
  })
  .strict();

const getOutput = {
  ...batchFields,
  results: z
    .array(resultRow)
    .optional()
    .describe('One row per item from the result file, once the batch finishes.'),
  resultsError: z
    .string()
    .optional()
    .describe('Why the result file could not be read; the batch fields are still current.'),
};

const listInput = z
  .object({
    status: z
      .enum(LIST_STATUSES)
      .optional()
      .describe('Only batches in this status, such as PROCESSING for batches still running.'),
    createdAfter: z.string().optional().describe('ISO 8601 date-time.'),
    createdBefore: z.string().optional().describe('ISO 8601 date-time.'),
  })
  .strict();

function payloadProblem(payload: Record<string, unknown>): string | undefined {
  // The API expands Edit Dialogue rows itself, with their own checks.
  if (payload.dialogueEdit !== undefined) return undefined;
  if (typeof payload.model !== 'string' || payload.model.trim() === '')
    return 'payload.model must name a model, such as sync-3 (see models_list)';
  if (!Array.isArray(payload.input) || payload.input.length === 0)
    return 'payload.input must list the inputs, such as {type: "video", url} and {type: "audio", url}';
  const bad = payload.input.findIndex(
    (entry) => !isRecord(entry) || typeof entry.type !== 'string',
  );
  return bad === -1 ? undefined : `payload.input[${bad}] needs a type: video, image, audio or text`;
}

type BatchRow = { request_id: string; endpoint: '/v2/generate'; payload: Record<string, unknown> };

/** The API's rows, or an error naming every item it would refuse (up to a few). */
export function buildBatchRows(items: z.infer<typeof item>[]): BatchRow[] {
  const problems: string[] = [];
  const firstUse = new Map<string, number>();
  items.forEach(({ requestId, payload }, index) => {
    if (requestId !== undefined) {
      const first = firstUse.get(requestId);
      if (first === undefined) firstUse.set(requestId, index);
      else problems.push(`items[${index}].requestId "${requestId}" repeats items[${first}]`);
    }
    const problem = payloadProblem(payload);
    if (problem) problems.push(`items[${index}]: ${problem}`);
  });
  if (problems.length > 0) {
    const more = problems.length - MAX_REPORTED_PROBLEMS;
    throw new Error(
      `The batch was not sent. ${problems.slice(0, MAX_REPORTED_PROBLEMS).join('; ')}${more > 0 ? `; and ${more} more` : ''}. Every requestId must be unique in the batch.`,
    );
  }
  const rows = items.map(({ requestId, payload }, index) => {
    let id = requestId ?? `item-${index + 1}`;
    if (requestId === undefined && firstUse.has(id)) id = `${id}-${randomUUID().slice(0, 8)}`;
    firstUse.set(id, index);
    return { request_id: id, endpoint: '/v2/generate' as const, payload };
  });
  const bytes = Buffer.byteLength(rows.map((row) => JSON.stringify(row)).join('\n'));
  if (bytes > MAX_JSONL_BYTES)
    throw new Error(
      `The batch was not sent: it is ${(bytes / 1024 / 1024).toFixed(1)} MB as JSONL and the API takes at most 5 MB. Split the items into smaller batches.`,
    );
  return rows;
}

const BATCH_LIMIT_STEP =
  'This account already runs as many batches as its plan allows (activeBatches of concurrencyLimit). Wait for one to finish, with batches_list status PROCESSING or batches_get wait: true, then create this batch once. Creating it again before then fails the same way.';

function planStep(requiredPlan: string | undefined): string {
  const plan =
    requiredPlan === 'enterprise'
      ? ' No self-serve plan includes it; the user can contact sync.'
      : requiredPlan
        ? ` It needs the ${requiredPlan} plan or above.`
        : '';
  return `Batch is not on this account’s plan.${plan} Tell the user, with billingUrl when present, where a person can change the plan. Meanwhile, create the generations one at a time with lipsync_create or dubbing_create. Creating the batch again fails the same way until the plan changes.`;
}

/** Tell the agent what changes the outcome; API lines are 1-based item positions. */
function explainCreateError(error: unknown): never {
  if (!(error instanceof ApiRequestError)) throw error;
  if (error.status === 402 && error.code === 'plan_feature_unavailable')
    error.nextStep = planStep(error.details?.requiredPlan);
  else if (error.status === 429 && error.code === 'concurrency_limit_reached')
    error.nextStep = BATCH_LIMIT_STEP;
  else if (error.status === 400 || error.status === 422) {
    const line = error.details?.lineNumber;
    error.nextStep = `${line ? `Line ${line} is items[${line - 1}]. ` : 'An API message citing line N means items[N-1]. '}Fix the items, check with dryRun: true, then create the batch once.`;
  }
  throw error;
}

/** Running share of the batch, for progress notifications. */
export function batchProgress(batch: Record<string, unknown>): number | undefined {
  const counts = isRecord(batch.metrics) ? batch.metrics : {};
  const total = Number(counts.total_generations);
  const done = Number(counts.success_count ?? 0) + Number(counts.failed_count ?? 0);
  return total > 0 && Number.isFinite(done) ? Math.min((done / total) * 100, 100) : undefined;
}

export function createBatchTools(
  operations: ParsedOperation[],
  http: HttpClient,
  apiBaseUrl: string,
): McpToolDefinition[] {
  if (!supportsBatches(operations)) return [];
  const readBatch = async (id: string, signal?: AbortSignal) => {
    const batch = await http.request('get', `/v2/batch/${encodeURIComponent(id)}`, { signal });
    return isRecord(batch) ? batch : { id, status: 'UNKNOWN' };
  };
  const get = async (args: Record<string, unknown>, context?: ToolRequestContext) => {
    const input = getInput.parse(args);
    const batch = input.wait
      ? await pollUntil(
          (signal) => readBatch(input.id, signal),
          (b) => BATCH_DONE.has(String(b.status)),
          context,
          {
            describe: (b) => {
              const progress = batchProgress(b);
              return `batch ${String(b.status).toLowerCase()}${progress === undefined ? '' : ` ${Math.round(progress)}%`}`;
            },
          },
        )
      : await readBatch(input.id, context?.signal);
    return withResults(batch, input.results ?? 'all', apiBaseUrl, context?.signal);
  };
  return [
    {
      name: 'batches_create',
      title: 'Create a batch of generations',
      description: `Submit many independent lipsync generations at once as one Sync batch, such as localizing one campaign video into many languages or syncing many videos to their own audio. Each item is one /v2/generate body; Sync queues them, so they skip the per-generation concurrency limit, and results can take up to a day. Use it for ${MIN_ITEMS} or more generations that do not depend on each other; for fewer, or when one result feeds the next, use lipsync_create or dubbing_create per video. Call with dryRun: true first to have the API check every item without creating anything. This is a paid action: every item is billed as its own generation. Before creating, estimate a representative item with generations_estimate-cost, tell the user the item count and the estimated total, and wait for their confirmation. Not idempotent: each call creates a new batch, so after an uncertain response check batches_list before creating again. Leave payload.projectId out for new work; a payload with projectId needs projectIntent=explicit, which only an explicit user selection or a project just created for this request allows. Batch may not be on every plan: a 402 names requiredPlan and billingUrl. Returns the batch id and each item's requestId; then call batches_get with wait: true.`,
      inputSchema: createInput.shape,
      outputSchema: createOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (args, context) => {
        const { items, dryRun, webhookUrl, projectIntent } = createInput.parse(args);
        assertProjectIntent(items, projectIntent);
        const rows = buildBatchRows(items);
        const response = await http
          .request('post', '/v2/batch', {
            body: {
              rows,
              ...(dryRun ? { dry_run: true } : {}),
              ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
            },
            signal: context?.signal,
          })
          .catch(explainCreateError);
        return {
          ...(isRecord(response) ? response : {}),
          requestIds: rows.map((row) => row.request_id),
        };
      },
    },
    {
      name: 'batches_get',
      title: 'Read a batch',
      description:
        'Read a Sync batch: status, metrics (total, succeeded, failed, pending) and outputUrl. Once it is COMPLETED or FAILED, results lists each item by requestId with its generation status, generationId, outputMediaUrl or error. With wait: true it waits on the server for up to about 50 seconds and sends progress notifications; batches can take hours, so call again while it runs and never create the batch again.',
      inputSchema: getInput.shape,
      outputSchema: getOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: get,
    },
    {
      name: 'batches_list',
      title: 'List batches',
      description:
        'List this account’s Sync batches with their status and metrics, optionally by status or creation time. Use it to find a batch id, to check for a batch just created after an uncertain batches_create response, or to see which batches are still running. For the per-item results of one batch use batches_get.',
      inputSchema: listInput.shape,
      outputSchema: { batches: z.array(z.looseObject(batchFields)) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (args, context) => {
        const { status, createdAfter, createdBefore } = listInput.parse(args);
        const query = Object.fromEntries(
          Object.entries({
            status,
            created_after: createdAfter,
            created_before: createdBefore,
          }).filter((entry): entry is [string, string] => entry[1] !== undefined),
        );
        const batches = await http.request('get', '/v2/batch', { query, signal: context?.signal });
        return { batches: Array.isArray(batches) ? batches : [] };
      },
    },
  ];
}
