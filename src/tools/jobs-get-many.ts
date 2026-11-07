import { z } from 'zod';
import { ApiRequestError } from '../http-client.js';
import { currentOrganizationSession, runInOrganization } from '../organization-selection.js';
import type { McpToolDefinition, ToolRequestContext } from './generator.js';
import { isTerminal, JOB_KINDS, PREVIEW_JOB_KINDS } from './job-status.js';
import { pollUntil } from './job-wait.js';
import { type JobInput, type JobState, jobReaders, jobSettled, jobStateShape } from './jobs.js';

/**
 * jobs_get-many: the state of up to MAX_JOBS jobs of any kind in one call, such as the set
 * jobs_create-many started. Each job reads through the same per-kind reader as jobs_get, so
 * statuses and results match it; with wait: true it re-reads only the jobs still running.
 */

export const MAX_JOBS = 50;
// Parallel reads per call, so a full set does not burst 50 requests at the API at once.
const READS_IN_FLIGHT = 8;
// Never read a set again sooner than this, even when every job asks for no pause.
const MIN_PAUSE_MS = 1_000;

type Entry = JobState | (JobInput & { error: { message: string; status?: number; code?: string } });

const isRead = (entry: Entry): entry is JobState => !('error' in entry);
// A job that could not be read counts as settled, so a wait never holds for a wrong id.
const settled = (entry: Entry) => !isRead(entry) || jobSettled(entry);

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
) {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Reads a job in the organization that created it when a one-call organizationId did, as
 * jobs_get does for its single id; otherwise in this call's organization.
 */
function inCreatingOrganization<T>(job: JobInput, read: () => Promise<T>): Promise<T> {
  const session = currentOrganizationSession();
  const remembered = session?.organizationFor({ id: job.id });
  if (remembered === undefined || session!.isCurrent(remembered)) return read();
  return runInOrganization(remembered ?? undefined, read);
}

function counts(entries: Entry[]) {
  const count = { total: entries.length, running: 0, completed: 0, failed: 0, unreadable: 0 };
  for (const entry of entries) {
    if (!isRead(entry)) count.unreadable += 1;
    else if (entry.status === 'COMPLETED') count.completed += 1;
    else if (isTerminal(entry.status)) count.failed += 1;
    else count.running += 1;
  }
  return count;
}

export function createJobsGetManyTool(tools: McpToolDefinition[]): McpToolDefinition[] {
  const readers = jobReaders(tools, [...JOB_KINDS, ...PREVIEW_JOB_KINDS]);
  if (!readers) return [];
  const has = (kind: string) => (readers.kinds as string[]).includes(kind);
  const projectKinds = ['translation_preview', 'dialogue_preview', 'speech_preview'].filter(has);
  // Fields only some kinds use are offered only when this server reads those kinds.
  const job = z
    .object({
      kind: z.enum(readers.kinds).describe('Which kind of job id is.'),
      id: z.string().trim().min(1).describe('The job to read; see the tool description per kind.'),
      ...(projectKinds.length > 0 || has('import')
        ? {
            projectId: z
              .string()
              .optional()
              .describe(
                [
                  projectKinds.length > 0 ? `Required for ${projectKinds.join(', ')}` : '',
                  has('import') ? 'for import, the project passed to assets_create' : '',
                ]
                  .filter(Boolean)
                  .join('; ') + '.',
              ),
          }
        : {}),
      ...(has('dialogue_preview')
        ? {
            videoAssetId: z
              .string()
              .optional()
              .describe('dialogue_preview only: the videoAssetId the preview was created for.'),
          }
        : {}),
      ...(has('import')
        ? {
            projectIntent: z
              .literal('explicit')
              .optional()
              .describe(
                'import only: pass it when the assets_create call for this link needed it.',
              ),
          }
        : {}),
    })
    .strict();
  const input = z
    .object({
      jobs: z
        .array(job)
        .min(1)
        .max(MAX_JOBS)
        .describe(
          `The jobs to read, up to ${MAX_JOBS}; pass jobs_create-many's jobs list as it is.`,
        ),
      wait: z
        .boolean()
        .optional()
        .describe(
          'Wait on the server until every job is final or about 50 seconds pass, then return the latest states. If some are still running, call again with wait: true instead of sleeping.',
        ),
    })
    .strict();
  const state = z.object(jobStateShape(readers.kinds));
  const failure = z.object({
    kind: z.enum(readers.kinds),
    id: z.string(),
    error: z
      .object({ message: z.string(), status: z.number().optional(), code: z.string().optional() })
      .describe('Why this job could not be read; the other jobs are unaffected.'),
  });

  const readOne = async (entry: JobInput, context?: ToolRequestContext, signal?: AbortSignal) => {
    try {
      return await inCreatingOrganization(entry, () => readers.read(entry, context, signal));
    } catch (error) {
      signal?.throwIfAborted();
      const api = error instanceof ApiRequestError ? error : undefined;
      return {
        ...entry,
        error: {
          message: error instanceof Error ? error.message : String(error),
          ...(api ? { status: api.status, ...(api.code ? { code: api.code } : {}) } : {}),
        },
      } satisfies Entry;
    }
  };
  // Jobs already settled keep their last state; only running ones are read again.
  // A job is read again only once it is due: settled jobs never, and a job whose read asked
  // for a pause (an import's retryAfterMs) not before that pause ends. Others follow the
  // shared backoff.
  const readAll = (
    jobs: JobInput[],
    previous: Entry[] | undefined,
    dueAt: number[],
    context: ToolRequestContext | undefined,
    signal: AbortSignal | undefined,
  ) =>
    mapLimited(jobs, READS_IN_FLIGHT, async (entry, index) => {
      const last = previous?.[index];
      if (last && (settled(last) || Date.now() < (dueAt[index] ?? 0))) return last;
      const next = await readOne(entry, context, signal);
      dueAt[index] = Date.now() + (isRead(next) ? (next.retryAfterMs ?? 0) : 0);
      return next;
    });

  /**
   * The pause before the next round: the shared backoff while any running job has no pause
   * of its own, otherwise until the first such pause ends.
   */
  const pauseFor = (entries: Entry[], dueAt: number[]): number | undefined => {
    const waits = entries.flatMap((entry) =>
      settled(entry) ? [] : [isRead(entry) ? entry.retryAfterMs : undefined],
    );
    if (waits.length === 0 || waits.some((wait) => wait === undefined)) return undefined;
    const due = Math.min(
      ...entries.flatMap((entry, index) => (settled(entry) ? [] : [dueAt[index] ?? 0])),
    );
    return Math.max(due - Date.now(), MIN_PAUSE_MS);
  };

  return [
    {
      name: 'jobs_get-many',
      title: 'Read many Sync jobs',
      description: `Read up to ${MAX_JOBS} Sync jobs of any kind at once, such as the set jobs_create-many started, by kind and id (${readers.ids}). Returns each job as jobs_get does, {kind, id, status, progress?, estimatedFinishAt?, retryAfterMs?, result}, in input order, or {kind, id, error} for one that could not be read, plus counts of running, completed, failed and unreadable jobs. status is PENDING or PROCESSING while a job runs (never create it again), then COMPLETED, FAILED, REJECTED or CANCELED. Pass wait: true to wait on the server until all are final or about 50 seconds pass, with progress notifications; call again with wait: true while some are still running.`,
      inputSchema: input.shape,
      outputSchema: {
        jobs: z
          .array(z.union([state, failure]))
          .describe('Each job’s latest state, in input order.'),
        counts: z
          .object({
            total: z.number(),
            running: z.number(),
            completed: z.number(),
            failed: z.number().describe('FAILED, REJECTED or CANCELED.'),
            unreadable: z.number().describe('Jobs whose read failed; see their error.'),
          })
          .describe('How many jobs are in each state.'),
      },
      // An import can start the download it reads, so this is not read-only, as for jobs_get.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: readers.kinds.includes('import'),
      },
      handler: async (args, context) => {
        const { jobs: parsed, wait } = input.parse(args);
        const jobs = parsed as JobInput[];
        let latest: Entry[] | undefined;
        const dueAt: number[] = [];
        const read = async (signal?: AbortSignal) =>
          (latest = await readAll(jobs, latest, dueAt, context, signal));
        const entries = wait
          ? await pollUntil(read, (current) => current.every(settled), context, {
              describe: (current) => {
                const count = counts(current);
                return `${count.total - count.running} of ${count.total} jobs final`;
              },
              delayMs: (current) => pauseFor(current, dueAt),
            })
          : await read(context?.signal);
        return { jobs: entries, counts: counts(entries) };
      },
    },
  ];
}
