import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';

const PREVIEW_OPERATIONS = [
  ['post', '/v2/dubbing/jobs', 'DubbingJobs_createJob'],
  ['post', '/v2/dubbing/jobs/estimate', 'DubbingJobs_estimate'],
  ['get', '/v2/dubbing/jobs/{id}', 'DubbingJobs_getJob'],
] as const;

export function translationPreviewOperations(operations: ParsedOperation[]): ParsedOperation[] {
  return operations.filter((operation) =>
    PREVIEW_OPERATIONS.some(
      ([method, path, operationId]) =>
        operation.method === method &&
        operation.path === path &&
        operation.operationId === operationId,
    ),
  );
}

export function translationPreviewAvailable(operations: ParsedOperation[]): boolean {
  const matching = translationPreviewOperations(operations);
  return PREVIEW_OPERATIONS.every(([, , operationId]) =>
    matching.some((operation) => operation.operationId === operationId),
  );
}

const jobSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETING', 'COMPLETED', 'FAILED']),
  sourceAudioUrl: z.string().optional(),
  sourceLang: z.string(),
  targetLang: z.string(),
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

/** Only the new project-scoped, durably keyed API admits standalone previews. */
export function createTranslationPreviewTools(
  operations: ParsedOperation[],
  http: HttpClient,
): McpToolDefinition[] {
  if (!translationPreviewAvailable(operations)) return [];
  const source = z.object({ projectId: z.uuid(), audioAssetId: z.uuid() }).strict();
  const create = source.extend({
    targetLang: z.string().trim().min(1),
    sourceLang: z.string().default('auto'),
    idempotencyKey: z.uuid(),
  });
  const read = z.object({ projectId: z.uuid(), id: z.uuid() }).strict();
  return [
    {
      name: 'estimate-translation-preview',
      title: 'Estimate translated audio preview',
      description:
        'Read the server quote for translating saved audio in an accessible project. Does not translate or create a video. If preview.quotedDurationSeconds is shorter than preview.sourceDurationSeconds, offer the bounded preview or an upgrade. Before admission, save a new trimmed audio asset and quote that asset; this estimate never trims the original. External provider charges must be disclosed separately.',
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
          await http.request('post', '/v2/dubbing/jobs/estimate', {
            body: source.parse(args),
            signal: context?.signal,
          }),
        ),
    },
    {
      name: 'create-translation-preview',
      title: 'Translate audio for preview',
      description:
        'Create one paid translated-audio preview from a saved audio asset. Confirm language and displayed cost first. Persist one UUID idempotencyKey and reuse the same immutable request after an uncertain response. Poll the returned job; never redub because audio attachment failed. Final video generation is a separate, explicitly approved lip-sync operation using the translated audio asset.',
      inputSchema: create.shape,
      outputSchema: jobSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (args, context) => {
        const { idempotencyKey, ...body } = create.parse(args);
        return jobSchema.parse(
          await http.request('post', '/v2/dubbing/jobs', {
            body,
            headers: { 'Idempotency-Key': idempotencyKey },
            signal: context?.signal,
          }),
        );
      },
    },
    {
      name: 'get-translation-preview',
      title: 'Read translated audio preview',
      description:
        'Read the same project-authorized translation job. A recoveryRequired result means provider acceptance is uncertain; do not create another job. Does not start or retry translation.',
      inputSchema: read.shape,
      outputSchema: jobSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (args, context) => {
        const input = read.parse(args);
        return jobSchema.parse(
          await http.request('get', `/v2/dubbing/jobs/${input.id}`, {
            query: { projectId: input.projectId },
            signal: context?.signal,
          }),
        );
      },
    },
  ];
}
