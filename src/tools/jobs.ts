import { z } from 'zod';
import type { ApiRequestError } from '../http-client.js';
import { batchProgress } from './batches.js';
import { attemptImport, importWaitOptions } from './generated-adapters.js';
import type { McpToolDefinition, ToolRequestContext } from './generator.js';
import {
  importErrorStatus,
  isTerminal,
  JOB_KINDS,
  JOB_STATUSES,
  type JobKind,
  type JobStatus,
  jobStatus,
} from './job-status.js';
import { pollUntil } from './job-wait.js';

/**
 * jobs_get and jobs_wait: one way to read and wait on every kind of Sync job. Each kind
 * reads through the tool that already serves it, so its adapters, output projection and
 * errors stay the same, and jobs_wait waits with the shared pollUntil (budget and progress
 * notifications included). A kind is offered only when its read tool exists on this server.
 */

type JsonTool = Exclude<McpToolDefinition, { resultFormat: 'mcp' }>;
type JobInput = { kind: JobKind; id: string; projectId?: string; projectIntent?: 'explicit' };
type JobState = {
  kind: JobKind;
  id: string;
  status: JobStatus;
  progress?: number;
  estimatedFinishAt?: string;
  retryAfterMs?: number;
  result: Record<string, unknown>;
};
type Reading = Omit<JobState, 'kind' | 'id'>;

type KindSpec = {
  tool: string;
  label: string;
  /** Where the id comes from, for the descriptions. */
  id: string;
  read: (
    tool: JsonTool,
    input: JobInput,
    context: ToolRequestContext | undefined,
    signal: AbortSignal | undefined,
  ) => Promise<Reading>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** What the kind's own tool would show: its output schema's fields, when it has one. */
function project(tool: JsonTool, payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return { value: payload };
  if (!tool.outputSchema) return payload;
  return Object.fromEntries(
    Object.keys(tool.outputSchema)
      .filter((key) => key in payload)
      .map((key) => [key, payload[key]]),
  );
}

function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, 0), 100)
    : undefined;
}

const readJob =
  (args: (input: JobInput) => Record<string, unknown>): KindSpec['read'] =>
  async (tool, input, context, signal) => {
    const payload = await tool.handler(args(input), { ...context, signal });
    return { status: jobStatus(payload), result: project(tool, payload) };
  };

const KINDS: Record<JobKind, KindSpec> = {
  generation: {
    tool: 'generations_get',
    label: 'generation',
    id: 'the id from lipsync_create, dubbing_create, lipsync_create-timeline or dialogue-videos_create',
    read: async (tool, input, context, signal) => {
      // include=progress adds the worker's percent; the API's own long-poll would drop it.
      const progressQuery = 'include' in tool.inputSchema ? { include: 'progress' } : {};
      const payload = await tool.handler(
        { id: input.id, ...progressQuery },
        { ...context, signal },
      );
      const raw = isRecord(payload) ? payload : {};
      const progress = isRecord(raw.progress) ? raw.progress.percent : raw.progress_percent;
      const estimate = isRecord(raw.generationEstimate) ? raw.generationEstimate : {};
      const status = jobStatus(payload);
      return {
        status,
        ...(percent(progress) === undefined || isTerminal(status)
          ? {}
          : { progress: percent(progress) }),
        ...(typeof estimate.estimatedFinishAt === 'string' && !isTerminal(status)
          ? { estimatedFinishAt: estimate.estimatedFinishAt }
          : {}),
        result: project(tool, payload),
      };
    },
  },
  transcription: {
    tool: 'transcriptions_get',
    label: 'transcription',
    id: 'the id from transcriptions_create or dialogue-transcriptions_create',
    read: readJob((input) => ({ id: input.id })),
  },
  speaker_analysis: {
    tool: 'transcriptions_get-speaker-analysis',
    label: 'speaker analysis',
    id: 'the transcription id',
    read: readJob((input) => ({ id: input.id })),
  },
  translation_preview: {
    tool: 'translation-previews_get',
    label: 'translation',
    id: 'the translation-previews_create id, plus its projectId',
    read: readJob((input) => {
      if (!input.projectId) throw new Error('Pass the projectId of the translation preview.');
      return { projectId: input.projectId, id: input.id };
    }),
  },
  import: {
    tool: 'assets_create',
    label: 'import',
    id: 'the social video link passed to assets_create, plus the same projectId (and projectIntent if that call needed it)',
    read: async (tool, input, context, signal) => {
      // Reading an import repeats the identical request; the API reuses the running import.
      const args = {
        url: input.id,
        type: 'VIDEO',
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.projectIntent === undefined ? {} : { projectIntent: input.projectIntent }),
      };
      try {
        const attempt = await attemptImport(tool.handler, args, context, signal);
        if ('asset' in attempt)
          return { status: 'COMPLETED', result: project(tool, attempt.asset) };
        const { pending } = attempt;
        const progress = percent(pending.importDetails?.progress);
        return {
          status: importErrorStatus(pending) ?? 'PROCESSING',
          ...(progress === undefined ? {} : { progress }),
          retryAfterMs: importWaitOptions.delayMs(attempt),
          result: { code: pending.code, message: pending.message, ...pending.importDetails },
        };
      } catch (error) {
        const status = importErrorStatus(error);
        if (!status) throw error;
        const { message, status: httpStatus, code } = error as ApiRequestError;
        return { status, result: { error: { message, status: httpStatus, code } } };
      }
    },
  },
  batch: {
    tool: 'batches_get',
    label: 'batch',
    id: 'the batches_create id',
    read: async (tool, input, context, signal) => {
      const payload = await tool.handler({ id: input.id }, { ...context, signal });
      const status = jobStatus(payload);
      const progress = isRecord(payload) ? batchProgress(payload) : undefined;
      return {
        status,
        ...(progress === undefined || isTerminal(status) ? {} : { progress }),
        result: project(tool, payload),
      };
    },
  },
};

const COUNT_WORDS = ['one', 'two', 'three', 'four', 'five', 'six'];

const GET_TAIL =
  "PENDING and PROCESSING mean still running: never create the job again. COMPLETED, FAILED, REJECTED (the API refused it, such as an import limit or a moderation rejection) and CANCELED are final. result is the job as the kind's own read tool returns it, with its original status; a COMPLETED import's result is the saved asset, whose id is the asset id, and a finished batch's result.results lists each item's generation status and output. A translation_preview with result.recoveryRequired true has uncertain provider acceptance: do not create another job. Reading an import resends the identical assets_create request, which returns the running import or its saved asset and starts the import if none exists; that is why this is not read-only. An unknown id, an auth failure or a translation_preview without projectId returns a tool error, not a status.";

const WAIT_INTRO =
  'Wait on the server, for up to about 50 seconds, until any job reaches a final status, then return its latest state in the same shape as jobs_get. Use it after a create tool returns an id, instead of sleeping or calling jobs_get in a loop; if the job is still PENDING or PROCESSING when it returns, call jobs_wait again with the same input. For one check without waiting use jobs_get. It also returns early on result.recoveryRequired and sends progress notifications when the call has a progressToken.';

const WAIT_TAIL =
  "Statuses:\n- PENDING, PROCESSING: still running. Never create the job again.\n- COMPLETED, FAILED, REJECTED (the API refused it, such as an import limit or a moderation rejection), CANCELED: final. A speaker analysis that is unavailable reads as FAILED.\nResults:\n- result keeps the kind's original status. A COMPLETED import's result is the saved asset, whose id is the asset id; a finished batch's result.results lists each item's generation status and output.\n- A translation_preview with result.recoveryRequired true has uncertain provider acceptance: do not create another job.\nNot read-only: an import read repeats the identical assets_create request, so it returns the running import or the saved asset, and starts the import for a link never imported (a non-social media URL is saved as a new VIDEO asset).\nErrors: an API failure that is not a job status, such as an unknown generation or transcription id or an auth failure, returns {error}; a translation_preview without projectId fails with a plain error message.";

export function createJobTools(tools: McpToolDefinition[]): McpToolDefinition[] {
  const available = JOB_KINDS.flatMap((kind) => {
    const tool = tools.find((candidate) => candidate.name === KINDS[kind].tool);
    return tool && tool.resultFormat !== 'mcp' ? [{ kind, tool, spec: KINDS[kind] }] : [];
  });
  if (available.length === 0) return [];
  const kinds = available.map((entry) => entry.kind) as [JobKind, ...JobKind[]];
  const input = z
    .object({
      kind: z.enum(kinds).describe('Which kind of job id is.'),
      id: z
        .string()
        .trim()
        .min(1)
        .describe(
          'The job id for the chosen kind, as listed in the tool description; for import it is the social video link itself.',
        ),
      projectId: z
        .string()
        .optional()
        .describe(
          'Required for translation_preview; for import, the project passed to assets_create.',
        ),
      projectIntent: z
        .literal('explicit')
        .optional()
        .describe('import only: pass it when the assets_create call for this link needed it.'),
    })
    .strict();
  const output = {
    kind: z.enum(kinds),
    id: z.string(),
    status: z.enum(JOB_STATUSES).describe('The unified status; see the tool description.'),
    progress: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Percent complete while running, when the API reports it.'),
    estimatedFinishAt: z
      .string()
      .optional()
      .describe('Server estimate (ISO 8601) of when a running job finishes, when the API has one.'),
    retryAfterMs: z
      .number()
      .optional()
      .describe('How long to wait before reading again, when the API asks for a pause.'),
    result: z
      .record(z.string(), z.unknown())
      .describe('The job as the kind’s own read tool returns it.'),
  };
  const ids = `Ids by kind:\n${available.map(({ kind, spec }) => `- ${kind}: ${spec.id}`).join('\n')}`;
  const count = COUNT_WORDS[available.length - 1];
  const read = async (
    args: Record<string, unknown>,
    context?: ToolRequestContext,
    signal = context?.signal,
  ) => {
    const job = input.parse(args);
    const entry = available.find((candidate) => candidate.kind === job.kind)!;
    const reading = await entry.spec.read(entry.tool as JsonTool, job, context, signal);
    return { kind: job.kind, id: job.id, ...reading } satisfies JobState;
  };
  // An import can start the download it reads, so neither tool is read-only.
  const annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: kinds.includes('import'),
  };
  return [
    {
      name: 'jobs_get',
      title: 'Read any Sync job',
      description: `Read any sync. job once, by kind and id, with one status vocabulary for all ${count} kinds. Use it to check a job without waiting or to track jobs of different kinds the same way. Not for waiting: use jobs_wait instead of calling this in a loop. For a kind's extra read options, such as generations_get include or batches_get results, call that tool directly.\n${ids}\n${GET_TAIL}`,
      inputSchema: input.shape,
      outputSchema: output,
      annotations,
      handler: (args, context) => read(args, context),
    },
    {
      name: 'jobs_wait',
      title: 'Wait for any Sync job',
      description: `${WAIT_INTRO}\n${ids}\n${WAIT_TAIL}`,
      inputSchema: input.shape,
      outputSchema: output,
      annotations,
      handler: async (args, context) => {
        const label = KINDS[input.parse(args).kind].label;
        return pollUntil(
          (signal) => read(args, context, signal),
          (job) => isTerminal(job.status) || job.result.recoveryRequired === true,
          context,
          {
            describe: (job) =>
              `${label} ${job.status.toLowerCase()}${job.progress === undefined ? '' : ` ${Math.round(job.progress)}%`}`,
            delayMs: (job) => job.retryAfterMs,
          },
        );
      },
    },
  ];
}
