import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import { schemaProperty } from '../openapi/parser.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';
import { jobSettled } from './job-status.js';
import { pollUntil, waitInput } from './job-wait.js';

const PREVIEW_OPERATIONS = [
  ['post', '/v2/integrations/dubbing'],
  ['post', '/v2/integrations/dubbing/estimate'],
  ['get', '/v2/integrations/dubbing/{id}'],
] as const;

export function translationPreviewOperations(operations: ParsedOperation[]): ParsedOperation[] {
  return operations.filter((operation) =>
    PREVIEW_OPERATIONS.some(
      ([method, path]) => operation.method === method && operation.path === path,
    ),
  );
}

export function translationPreviewAvailable(operations: ParsedOperation[]): boolean {
  const matching = translationPreviewOperations(operations);
  return PREVIEW_OPERATIONS.every(([method, path]) => {
    const operation = matching.find(
      (candidate) => candidate.method === method && candidate.path === path,
    );
    if (operation?.savedAssetDubbingVersion !== 1) return false;
    if (method === 'get')
      return operation.parameters.some(
        (parameter) =>
          parameter.in === 'query' &&
          parameter.name === 'projectId' &&
          parameter.schema.type === 'string' &&
          parameter.schema.format === 'uuid',
      );
    if (operation.requestBody?.contentType !== 'application/json') return false;
    const schema = operation.requestBody.schema;
    if (
      ['audioAssetId', 'projectId'].some((name) => {
        const property = schemaProperty(schema, name);
        return property?.type !== 'string' || property.format !== 'uuid';
      })
    )
      return false;
    return (
      path.endsWith('/estimate') ||
      operation.parameters.some(
        (parameter) =>
          parameter.in === 'header' &&
          parameter.name.toLowerCase() === 'idempotency-key' &&
          parameter.schema.type === 'string',
      )
    );
  });
}

const jobSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETING', 'COMPLETED', 'FAILED']),
  sourceAudioUrl: z.string().optional(),
  sourceLang: z.string(),
  targetLang: z.string(),
  cloningStrength: z.number().int().nullable().optional(),
  outputMediaUrl: z.string().nullable(),
  outputDurationSec: z.number().nonnegative().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  recoveryRequired: z.boolean(),
  createdAt: z.string().optional(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
});
const quoteSchema = z.object({
  billing: z.enum(['sync_credits', 'sync_usd', 'included', 'external']),
  estimatedGenerationCost: z.number().nonnegative().nullable(),
  estimatedCredits: z.number().nonnegative().nullable(),
  preview: z
    .object({
      sourceDurationSeconds: z.number().positive(),
      quotedDurationSeconds: z.number().positive(),
      limitSeconds: z.number().positive().nullable(),
    })
    .optional(),
});

/** The existing translation API must advertise saved-source authorization and keyed recovery. */
export function createTranslationPreviewTools(
  operations: ParsedOperation[],
  http: HttpClient,
): McpToolDefinition[] {
  if (!translationPreviewAvailable(operations)) return [];
  const projectId = z
    .uuid()
    .describe('Project the translation belongs to, from projects_create or projects_list.');
  const source = z
    .object({
      projectId,
      audioAssetId: z
        .uuid()
        .describe(
          'Saved AUDIO asset to quote, such as one from assets_create (type=AUDIO), assets_list or audio-trims_create; the same asset translation-previews_create will translate.',
        ),
    })
    .strict();
  const create = source.extend({
    projectId: projectId.describe(
      'Project for the job: one just created with projects_create for this request, or one the user explicitly selected; pass projectIntent=explicit with it. Use the same id for translation-previews_get.',
    ),
    audioAssetId: z
      .uuid()
      .describe(
        'Saved AUDIO asset to translate, such as one from assets_create (type=AUDIO), assets_list or audio-trims_create; the same asset you quoted with translation-previews_estimate.',
      ),
    targetLang: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Language code to translate into, from dubbing_get-options targetLanguages (for example es or pt-BR).',
      ),
    // Detected from the audio. Still accepted from callers holding the old tool list.
    sourceLang: z
      .string()
      .optional()
      .describe('Optional and usually omitted: the source language is detected (sent as auto).'),
    idempotencyKey: z
      .uuid()
      .describe(
        'A new UUID saved before the call. Reuse it with identical input only to recover an uncertain response.',
      ),
  });
  const read = z
    .object({
      projectId: projectId.describe(
        'The projectId passed to translation-previews_create for this job.',
      ),
      id: z.uuid().describe('Translation preview id from translation-previews_create.'),
    })
    .strict();
  const waitable = read.extend({ wait: waitInput });
  return [
    {
      name: 'translation-previews_estimate',
      title: 'Estimate translated audio preview',
      description:
        "Quote translating one saved audio asset with translation-previews_create, before creating it. Use it to price a translated-audio preview; for a full video dub, quote dubbing_create with generations_estimate-cost workflow=translate-and-dub instead. Read-only and free: it does not translate, create a job, trim or modify the audio, or incur provider charges. Pass the same projectId, audioAssetId and organizationId you will pass to translation-previews_create, so the quote matches the job that gets billed.\n\nReturns billing (sync_credits, sync_usd, included, or external, meaning provider charges outside sync. that you must disclose separately), estimatedGenerationCost and estimatedCredits (either may be null), and preview durations.\n\nIf preview.quotedDurationSeconds is shorter than sourceDurationSeconds, the source exceeds limitSeconds, the free plan's dubbing duration limit (a paid plan lifts it), and only that bounded part was quoted. Explain the limit and offer the bounded preview, but never submit the original: translation-previews_create refuses it instead of trimming it. Save a shorter copy as a new audio asset (audio-trims_create, when listed, with durationSeconds up to limitSeconds), then quote and create with that asset.",
      inputSchema: source.shape,
      outputSchema: quoteSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (args, context) =>
        quoteSchema.parse(
          await http.request('post', '/v2/integrations/dubbing/estimate', {
            body: { ...source.parse(args), preview: true },
            signal: context?.signal,
          }),
        ),
    },
    {
      name: 'translation-previews_create',
      title: 'Translate audio for preview',
      description:
        "Start one paid job that translates a saved audio asset's speech into another language, producing translated audio the user can review before a separate lipsync. Use it when the user wants to hear the translation first or place the audio on a timeline; for a finished dubbed video in one step use dubbing_create, and for speech from a script use speech-previews_create. Confirm the source audio, target language and the translation-previews_estimate quote with the user first. It needs a project: for new work call projects_create (defaultWorkflow translate_and_dub) and pass that id with projectIntent=explicit; use an existing project only when the user explicitly selected it, never because of a matching name or open editor. Persist one UUID idempotencyKey before calling and, after an uncertain response, resend the identical request with it; a new key bills again. Returns the job (id, status, outputMediaUrl once done, error, recoveryRequired); follow it with translation-previews_get wait: true, or jobs_wait kind translation_preview when available. Never translate again because attaching the output failed or recoveryRequired is true. Lipsyncing the translated audio is a separate, explicitly approved lipsync_create or lipsync_create-timeline call, not dubbing_create.",
      inputSchema: create.shape,
      outputSchema: jobSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // Paid, and only the model-chosen idempotencyKey deduplicates it: a retry with a new key bills again.
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (args, context) => {
        const { idempotencyKey, sourceLang, ...fields } = create.parse(args);
        return jobSchema.parse(
          await http.request('post', '/v2/integrations/dubbing', {
            body: { ...fields, sourceLang: sourceLang ?? 'auto' },
            headers: { 'Idempotency-Key': idempotencyKey },
            signal: context?.signal,
          }),
        );
      },
    },
    {
      name: 'translation-previews_get',
      title: 'Read translated audio preview',
      description:
        'Read one translated-audio preview job by id: status (PENDING, PROCESSING, COMPLETING while the finished audio is attached, then COMPLETED or FAILED), source and target languages, error, recoveryRequired, and once COMPLETED outputMediaUrl and outputDurationSec. Use it to follow a translation-previews_create job; jobs_get and jobs_wait with kind translation_preview, when available, read the same job through the generic job tools. Pass wait: true to hold on the server for up to about 50 seconds until the job finishes or recoveryRequired is set; if it is still running, call again. Read-only: it never starts, retries or bills a translation. On FAILED, report error.message; another attempt is a new paid translation-previews_create the user must approve. recoveryRequired means provider acceptance is uncertain and only sync. can resolve it: do not create another job. Once COMPLETED, register outputMediaUrl with assets_create (type=AUDIO) or pass it as a clip audioUrl to lipsync_create-timeline for the separate lipsync step.',
      inputSchema: waitable.shape,
      outputSchema: jobSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (args, context) => {
        const { wait, ...fields } = waitable.parse(args);
        const input = read.parse(fields);
        const get = async (signal = context?.signal) =>
          jobSchema.parse(
            await http.request('get', `/v2/integrations/dubbing/${input.id}`, {
              query: { projectId: input.projectId },
              signal,
            }),
          );
        if (!wait) return get();
        return pollUntil(get, jobSettled, context, {
          describe: (job) => `translation ${job.status.toLowerCase()}`,
        });
      },
    },
  ];
}
