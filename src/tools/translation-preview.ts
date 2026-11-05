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
  const source = z.object({ projectId: z.uuid(), audioAssetId: z.uuid() }).strict();
  const create = source.extend({
    targetLang: z.string().trim().min(1),
    // Detected from the audio. Still accepted from callers holding the old tool list.
    sourceLang: z.string().optional().describe('Optional; the source language is detected.'),
    idempotencyKey: z.uuid(),
  });
  const read = z.object({ projectId: z.uuid(), id: z.uuid() }).strict();
  const waitable = read.extend({ wait: waitInput });
  return [
    {
      name: 'translation-previews_estimate',
      title: 'Estimate translated audio preview',
      description:
        'Read the server quote for translating saved audio in an accessible project. Does not translate, create a video, modify saved audio, or incur provider charges. If preview.quotedDurationSeconds is shorter than preview.sourceDurationSeconds, explain the duration limit and offer the bounded preview. Before admission, save a new trimmed audio asset and quote that asset; this estimate never trims the original. External provider charges must be disclosed separately.',
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
        'Create one paid translated-audio preview from a saved audio asset. Confirm language and displayed cost first. Persist one UUID idempotencyKey and reuse the same immutable request after an uncertain response. Poll the returned job; never redub because audio attachment failed. Final video generation is a separate, explicitly approved lip-sync operation using the translated audio asset.',
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
        'Read the same project-authorized translation job; pass wait: true to wait for it on the server. A recoveryRequired result means provider acceptance is uncertain; do not create another job. Does not start or retry translation. When COMPLETED, outputMediaUrl can be registered with assets_create (type=AUDIO) or, when available, passed as a clip audioUrl to lipsync_create-timeline.',
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
