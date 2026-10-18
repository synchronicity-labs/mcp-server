import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';

const createPath = '/v2/tts/jobs';
const readPath = '/v2/tts/jobs/{id}';
export function speechOperations(operations: ParsedOperation[]) {
  return operations.filter(
    (operation) => operation.path === createPath || operation.path === readPath,
  );
}
const projectSchema = z.object({ projectId: z.uuid() });
const requestSchema = projectSchema.extend({
  idempotencyKey: z
    .uuid()
    .describe(
      'Persist this request identity before synthesis. Reuse it with the identical script and voice after an uncertain response.',
    ),
  script: z.string().min(1).max(5000),
  voiceId: z
    .string()
    .min(1)
    .describe('An id returned by voices_get-voices. Restricted voices cannot synthesize.'),
  stability: z.number().min(0).max(1).optional(),
  similarityBoost: z.number().min(0).max(1).optional(),
});
const jobSchema = z.object({
  id: z.uuid(),
  status: z.enum(['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED']),
  url: z.url().nullable(),
  duration: z.number().finite().nonnegative().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
// Return only the fields needed for Studio's speech quote and admission UI.
const billingSchema = z.object({
  plan: z.string().nullable(),
  billingVersion: z.enum(['v2', 'v3']).optional(),
  hasActiveCredits: z.boolean(),
  freeTtsExhausted: z.boolean(),
  freeGenerationsExhausted: z.boolean().optional(),
  paymentFailureCountExceededLimit: z.boolean(),
  freeMonthlyLimits: z
    .object({
      tts: z.object({ used: z.number().nonnegative(), max: z.number().nonnegative() }),
      generations: z
        .object({ used: z.number().nonnegative(), max: z.number().nonnegative() })
        .optional(),
      sync3: z.object({ used: z.number().nonnegative(), max: z.number().nonnegative() }).optional(),
    })
    .nullable(),
});
const optionsSchema = billingSchema.extend({ available: z.literal(true) });
const readHints = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export function createSpeechTools(
  operations: ParsedOperation[],
  httpClient: HttpClient,
): McpToolDefinition[] {
  const selected = speechOperations(operations);
  if (
    !selected.some((op) => op.path === createPath && op.method === 'post') ||
    !selected.some((op) => op.path === readPath && op.method === 'get')
  )
    return [];
  async function checkProject(args: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { projectId } = projectSchema.parse(args);
    const project = z
      .object({ id: z.uuid() })
      .parse(await httpClient.request('get', `/v2/projects/${projectId}`, { signal }));
    if (project.id !== projectId) throw new Error('Could not verify project access.');
    signal?.throwIfAborted();
  }
  return [
    {
      name: 'get-speech-options',
      title: 'Check speech preview availability',
      description:
        'Read speech-preview availability and the connected organization’s billing mode/free allowance for a Studio quote. Does not synthesize or change billing.',
      inputSchema: projectSchema.shape,
      outputSchema: optionsSchema.shape,
      annotations: readHints,
      handler: async (args, context) => {
        await checkProject(args, context?.signal);
        const billing = billingSchema.parse(
          await httpClient.request('get', '/v2/billing', { signal: context?.signal }),
        );
        return { ...billing, available: true };
      },
    },
    {
      name: 'create-speech-preview',
      title: 'Generate a speech preview',
      description:
        'Synthesize the confirmed script and selected available voice into a durable audio job for the project. This is a potentially paid action. Persist idempotencyKey before calling, reuse that same key and identical input after uncertain admission, and poll get-speech-preview by returned id. Never create again merely because attaching the resulting audio failed.',
      inputSchema: requestSchema.shape,
      outputSchema: jobSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
      handler: async (args, context) => {
        const { projectId: _projectId, idempotencyKey, ...body } = requestSchema.parse(args);
        await checkProject(args, context?.signal);
        return jobSchema.parse(
          await httpClient.request('post', createPath, {
            body: { ...body, provider: 'elevenlabs' },
            headers: { 'Idempotency-Key': idempotencyKey },
            signal: context?.signal,
          }),
        );
      },
    },
    {
      name: 'get-speech-preview',
      title: 'Check a speech preview',
      description:
        'Read the same durable speech job until SUCCESS or FAILED. Reads do not synthesize. Requires an accessible project in the connected organization; the audio is attached separately by the app.',
      inputSchema: projectSchema.extend({ id: z.uuid() }).shape,
      outputSchema: jobSchema.shape,
      annotations: readHints,
      handler: async (args, context) => {
        const id = z.uuid().parse(args.id);
        await checkProject(args, context?.signal);
        return jobSchema.parse(
          await httpClient.request('get', `${createPath}/${id}`, { signal: context?.signal }),
        );
      },
    },
  ];
}
