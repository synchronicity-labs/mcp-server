import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import { generateTools, type McpToolDefinition } from './generator.js';
import { modelOptionsSchema } from './model-options.js';
import { generationOutputSchema } from './output-schemas.js';

const paths = [
  '/v2/transcriptions',
  '/v2/transcriptions/{id}',
  '/v2/dialogue-edits',
  '/v2/dialogue-edits/{id}',
];
export function dialogueOperations(operations: ParsedOperation[]) {
  return operations.filter((operation) => paths.includes(operation.path));
}
const sourceSchema = z.object({ projectId: z.uuid(), videoAssetId: z.uuid() });
const object = z.record(z.string(), z.unknown());

export function createDialogueTools(
  operations: ParsedOperation[],
  httpClient: HttpClient,
): McpToolDefinition[] {
  const selected = dialogueOperations(operations);
  const tools = generateTools(selected, httpClient);
  const find = (path: string, method: string) =>
    tools[selected.findIndex((op) => op.path === path && op.method === method)];
  const transcribe = find(paths[0]!, 'post');
  const readTranscript = find(paths[1]!, 'get');
  const preview = find(paths[2]!, 'post');
  const readPreview = find(paths[3]!, 'get');
  if (!transcribe || !readTranscript || !preview || !readPreview || !preview.inputSchema.edits)
    return [];

  async function source(args: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const input = sourceSchema.parse(args);
    const project = object.parse(
      await httpClient.request('get', `/v2/projects/${input.projectId}`, { signal }),
    );
    if (project.id !== input.projectId) throw new Error('Could not verify project access.');
    signal?.throwIfAborted();
    const asset = z
      .object({ id: z.uuid(), type: z.literal('VIDEO'), url: z.url() })
      .parse(await httpClient.request('get', `/v2/assets/${input.videoAssetId}`, { signal }));
    if (asset.id !== input.videoAssetId) throw new Error('Could not verify the source video.');
    signal?.throwIfAborted();
    return { ...input, sourceVideoUrl: asset.url };
  }
  async function checkedJob(
    tool: McpToolDefinition,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const input = await source(args, signal);
    const job = object.parse(await tool.handler({ id: z.uuid().parse(args.id) }, { signal }));
    // URLs from the same API source must identify the same stored source. The
    // generation API performs its own storage-object comparison before billing.
    const sourceUrl = z.url().parse(job.sourceVideoUrl);
    const a = new URL(sourceUrl);
    const b = new URL(input.sourceVideoUrl);
    if (a.origin !== b.origin || a.pathname !== b.pathname)
      throw new Error('The job belongs to another source video.');
    return job;
  }
  const readHints = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const writeHints = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  };
  const generationSchema = sourceSchema.extend({
    dialogueEditId: z.uuid(),
    model: z.string().min(1),
    options: modelOptionsSchema.optional(),
  });
  async function generationBody(args: Record<string, unknown>, signal?: AbortSignal) {
    const input = generationSchema.parse(args);
    await source(args, signal);
    if (typeof input.options?.active_speaker_detection === 'boolean')
      input.options.active_speaker_detection = {
        auto_detect: input.options.active_speaker_detection,
      };
    return {
      projectId: input.projectId,
      model: input.model,
      input: [{ type: 'video', assetId: input.videoAssetId }],
      dialogueEdit: { id: input.dialogueEditId },
      ...(input.options ? { options: input.options } : {}),
    };
  }
  return [
    {
      name: 'get-dialogue-options',
      description:
        'Check whether the connected API supports timed-word Edit Dialogue. Does not transcribe, synthesize or generate.',
      inputSchema: {},
      annotations: readHints,
      handler: async () => ({ available: true }),
    },
    {
      name: 'create-dialogue-transcription',
      description:
        'Use this to start correcting or removing spoken words in a saved single-speaker video while keeping the original speaker voice. Transcribes timed words for Edit Dialogue; not whole-script replacement, translation, or choosing a different voice. Transcription is unbilled and identical sources reuse their existing job. Does not replace dialogue or generate a video.',
      inputSchema: sourceSchema.shape,
      annotations: writeHints,
      handler: async (args, context) => {
        const input = await source(args, context?.signal);
        return transcribe.handler(
          {
            sourceVideoUrl: input.sourceVideoUrl,
            projectId: input.projectId,
            maxSourceSeconds: 600,
          },
          context,
        );
      },
    },
    {
      name: 'get-dialogue-transcription',
      description:
        'Read the same transcription job until complete. Requires its original saved video and accessible project.',
      inputSchema: sourceSchema.extend({ id: z.uuid() }).shape,
      annotations: readHints,
      handler: (args, context) => checkedJob(readTranscript, args, context?.signal),
    },
    {
      name: 'create-dialogue-preview',
      description:
        'Preview timed word changes/removals in the original speaker’s voice. This is a synthesis action. Use a completed transcription, or a prior preview of this source when reopening. Confirm edits first. Never retry an ambiguous creation automatically. This is not arbitrary full-transcript replacement.',
      inputSchema: sourceSchema.extend({
        transcriptionId: z.uuid().optional(),
        previousPreviewId: z.uuid().optional(),
        edits: preview.inputSchema.edits,
      }).shape,
      annotations: writeHints,
      handler: async (args, context) => {
        if (Boolean(args.transcriptionId) === Boolean(args.previousPreviewId)) {
          throw new Error('Provide one transcriptionId or previousPreviewId, not both.');
        }
        const input = await source(args, context?.signal);
        const previous = args.previousPreviewId
          ? await checkedJob(readPreview, { ...args, id: args.previousPreviewId }, context?.signal)
          : undefined;
        const transcriptJob =
          previous ??
          (await checkedJob(
            readTranscript,
            { ...args, id: args.transcriptionId },
            context?.signal,
          ));
        if (
          transcriptJob.status !== 'COMPLETED' &&
          !(previous && transcriptJob.status === 'COMPLETED_PARTIAL')
        )
          throw new Error('Wait for the source transcript to finish.');
        return preview.handler(
          {
            sourceVideoUrl: input.sourceVideoUrl,
            projectId: input.projectId,
            transcript: previous ? previous.sourceTranscript : transcriptJob.transcript,
            edits: args.edits,
            ...(previous?.voiceId ? { voiceId: previous.voiceId } : {}),
            ...(previous && JSON.stringify(previous.edits) === JSON.stringify(args.edits)
              ? { rerunOfJobId: previous.id }
              : {}),
          },
          context,
        );
      },
    },
    {
      name: 'get-dialogue-preview',
      description:
        'Read one existing Edit Dialogue audio preview. Partial completion must be disclosed, not described as every edit succeeding.',
      inputSchema: sourceSchema.extend({ id: z.uuid() }).shape,
      annotations: readHints,
      handler: (args, context) => checkedJob(readPreview, args, context?.signal),
    },
    {
      name: 'estimate-dialogue-video',
      description:
        'Estimate final video cost using the completed dialogue preview and canonical server retiming. Does not generate or reserve credits.',
      inputSchema: generationSchema.shape,
      annotations: readHints,
      handler: async (args, context) =>
        httpClient.request('post', '/v2/analyze/cost', {
          body: await generationBody(args, context?.signal),
          signal: context?.signal,
        }),
    },
    {
      name: 'create-dialogue-video',
      description:
        'Generate the final video from an approved completed audio preview matching the current edits. Confirm the estimate first. Reuse the same idempotency key and inputs for recovery; poll generate_get-generation for the returned ID.',
      inputSchema: generationSchema.extend({
        idempotencyKey: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/),
      }).shape,
      outputSchema: generationOutputSchema,
      annotations: writeHints,
      handler: async (args, context) => {
        const key = z
          .string()
          .regex(/^[A-Za-z0-9._~-]{1,128}$/)
          .parse(args.idempotencyKey);
        return httpClient.request('post', '/v2/generate', {
          body: await generationBody(args, context?.signal),
          headers: { 'Idempotency-Key': key },
          signal: context?.signal,
        });
      },
    },
  ];
}
