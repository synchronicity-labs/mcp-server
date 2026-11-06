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
const projectSchema = z.object({
  projectId: z
    .uuid()
    .describe(
      'Project the speech preview is for, from projects_create or projects_list. Use the same id for speech-previews_create; an id you cannot access returns an error.',
    ),
});
const requestSchema = projectSchema.extend({
  projectId: projectSchema.shape.projectId.describe(
    'Project the preview is for, from projects_create or projects_list. The tool checks you can access it before synthesizing; pass the same id to speech-previews_get.',
  ),
  idempotencyKey: z
    .uuid()
    .describe(
      'A fresh UUID, persisted before the call and sent as the Idempotency-Key header. After an uncertain response, reuse it with the identical script and voice; only this key deduplicates, so a new key can bill a second synthesis.',
    ),
  script: z
    .string()
    .min(1)
    .max(5000)
    .describe('Exact text the user confirmed, spoken as written; up to 5,000 characters.'),
  voiceId: z
    .string()
    .min(1)
    .describe(
      "Voice id returned by voices_list (premade ElevenLabs voices or this organization's clones). A voice with a restriction cannot synthesize; pick another.",
    ),
  stability: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Voice consistency from 0 to 1; higher is steadier, lower is more expressive.'),
  similarityBoost: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('How closely to match the selected voice, from 0 to 1.'),
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
      name: 'speech-previews_get-options',
      title: 'Check speech preview availability',
      description:
        "Preflight one speech preview before speech-previews_create: confirm you can read projectId, then read the organization's text-to-speech billing state. It returns no price, so use it to tell the user before creating whether the preview fits the free monthly allowance (freeMonthlyLimits.tts used against max, when freeMonthlyLimits is not null) or will draw on paid usage, judged from hasActiveCredits, plan and billingVersion. If freeTtsExhausted or paymentFailureCountExceededLimit is true, tell the user to check their plan or billing in Studio instead of creating. Ignore freeGenerationsExhausted and the generations and sync3 counters; they cover other generations, not speech. available is always true when the call succeeds; if the project check or billing read fails, the call returns an error and no billing fields. Not for overall balance or spend (account_get-usage) or choosing a voice (voices_list). Does not synthesize or bill.",
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
      name: 'speech-previews_create',
      title: 'Generate a speech preview',
      description:
        'Synthesize a confirmed script in a voice from voices_list into one standalone speech audio job (ElevenLabs), after verifying access to projectId. This is a potentially paid action. Check speech-previews_get-options first, persist idempotencyKey before calling, and after an uncertain response retry only with that same key and identical input; a new key can bill again. Returns the job: status PENDING, PROCESSING, SUCCESS or FAILED, with url and duration filled only on SUCCESS, so poll speech-previews_get by the returned id (jobs_get and jobs_wait do not cover speech jobs). Never create again because attaching the resulting audio failed. An inaccessible project or a malformed idempotencyKey fails before anything is synthesized. Not for lipsyncing a script directly (lipsync_create with script and voiceId), editing words in a video in the original speaker voice (dialogue-previews_create) or translating audio (translation-previews_create). Pass projectIntent=explicit with projectId only for a project the user explicitly chose or one just created for this request, never because its name matches or it is open; default new work to a new project.',
      inputSchema: requestSchema.shape,
      outputSchema: jobSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        // Paid, and only the model-chosen idempotencyKey deduplicates it: a retry with a new key bills again.
        idempotentHint: false,
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
      name: 'speech-previews_get',
      title: 'Check a speech preview',
      description:
        "Read the status of one speech preview job created by speech-previews_create. PENDING or PROCESSING means it is still running; SUCCESS fills the audio url and duration; FAILED usually fills error with a code and message, but error can be null, so check it before reading. jobs_get and jobs_wait do not cover speech previews, and this tool has no wait option: call it again while the job runs, and never create another preview to recover a running one. projectId is only an access check (pass the one used at create); the job is looked up by id within the session's organization, and an inaccessible project or an id not found there returns an error. Does not synthesize or bill.",
      inputSchema: projectSchema.extend({
        projectId: projectSchema.shape.projectId.describe(
          'Project you passed to speech-previews_create, from projects_create or projects_list. It is read first to check access; an id you cannot access returns an error.',
        ),
        id: z.uuid().describe('Speech preview id from speech-previews_create.'),
      }).shape,
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
