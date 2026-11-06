import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import { uploadRuntime } from '../upload-runtime.js';
import {
  dialogueEdits,
  previewId,
  previewKeySchema,
  sourceSchema,
  transcriptionIdInput,
} from './dialogue-inputs.js';
import { DIALOGUE_TEXT } from './dialogue-text.js';
import { generationContextHeaders, generationContextSchema } from './generation-context.js';
import { generateTools, type McpToolDefinition } from './generator.js';
import { uploadMediaAsset } from './media-upload.js';
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
const object = z.record(z.string(), z.unknown());

/** transcriptionJobId is the API's name; transcriptionId is the older MCP name. */
function transcriptionJobId(args: Record<string, unknown>): unknown {
  const { transcriptionJobId: id, transcriptionId: alias } = args;
  if (id && alias && id !== alias)
    throw new Error(
      'transcriptionJobId and transcriptionId name different transcriptions; pass transcriptionJobId only.',
    );
  return id ?? alias;
}

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

  const keyedPreview = selected.some(
    (operation) =>
      operation.path === paths[2] &&
      operation.method === 'post' &&
      operation.parameters.some(
        (parameter) =>
          parameter.in === 'header' && parameter.name.toLowerCase() === 'idempotency-key',
      ),
  );

  async function source(args: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const input = sourceSchema.parse(args);
    const project = object.parse(
      await httpClient.request('get', `/v2/projects/${input.projectId}`, { signal }),
    );
    if (project.id !== input.projectId) throw new Error('Could not verify project access.');
    signal?.throwIfAborted();
    const asset = z
      .object({ id: z.uuid(), type: z.literal('VIDEO'), url: z.url(), name: z.string().nullish() })
      .parse(await httpClient.request('get', `/v2/assets/${input.videoAssetId}`, { signal }));
    if (asset.id !== input.videoAssetId) throw new Error('Could not verify the source video.');
    signal?.throwIfAborted();
    return { ...input, sourceVideoUrl: asset.url, sourceName: asset.name ?? 'dialogue-source.mp4' };
  }
  async function copyToSyncStorage(
    input: Awaited<ReturnType<typeof source>>,
    signal?: AbortSignal,
  ) {
    const assetId = await uploadMediaAsset(
      httpClient,
      'video',
      {
        download_url: input.sourceVideoUrl,
        file_id: input.videoAssetId,
        file_name: input.sourceName,
      },
      uploadRuntime,
      signal,
      { projectId: input.projectId, name: input.sourceName },
    );
    const asset = z
      .object({ id: z.uuid(), type: z.literal('VIDEO'), url: z.url() })
      .passthrough()
      .parse(await httpClient.request('get', `/v2/assets/${assetId}`, { signal }));
    if (asset.id !== assetId) throw new Error('Could not verify the uploaded video.');
    return asset;
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
  const estimateText = DIALOGUE_TEXT['dialogue-videos_estimate'];
  const generationSchema = sourceSchema.extend({
    dialogueEditId: z.uuid().describe(estimateText.params.dialogueEditId),
    model: z.string().min(1).describe(estimateText.params.model),
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
      name: 'dialogue_get-options',
      title: 'Check Edit Dialogue availability',
      description: DIALOGUE_TEXT['dialogue_get-options'].description,
      inputSchema: {},
      annotations: readHints,
      handler: async () => ({ available: true, keyedPreview, sourceUpload: true }),
    },
    {
      name: 'dialogue_upload-source',
      title: 'Copy a video for Edit Dialogue',
      description: DIALOGUE_TEXT['dialogue_upload-source'].description,
      inputSchema: sourceSchema.extend({
        projectId: sourceSchema.shape.projectId.describe(
          DIALOGUE_TEXT['dialogue_upload-source'].params.projectId,
        ),
        videoAssetId: sourceSchema.shape.videoAssetId.describe(
          DIALOGUE_TEXT['dialogue_upload-source'].params.videoAssetId,
        ),
      }).shape,
      outputSchema: {
        asset: z.object({ id: z.uuid(), type: z.literal('VIDEO'), url: z.url() }).passthrough(),
      },
      annotations: writeHints,
      handler: async (args, context) => ({
        asset: await copyToSyncStorage(await source(args, context?.signal), context?.signal),
      }),
    },
    {
      name: 'dialogue-transcriptions_create',
      title: 'Transcribe a video for Edit Dialogue',
      description: DIALOGUE_TEXT['dialogue-transcriptions_create'].description,
      inputSchema: sourceSchema.extend({
        projectId: sourceSchema.shape.projectId.describe(
          DIALOGUE_TEXT['dialogue-transcriptions_create'].params.projectId,
        ),
        videoAssetId: sourceSchema.shape.videoAssetId.describe(
          DIALOGUE_TEXT['dialogue-transcriptions_create'].params.videoAssetId,
        ),
      }).shape,
      annotations: writeHints,
      handler: async (args, context) => {
        const input = await source(args, context?.signal);
        const start = (sourceVideoUrl: string) =>
          transcribe.handler(
            { sourceVideoUrl, projectId: input.projectId, maxSourceSeconds: 600 },
            context,
          );
        try {
          return await start(input.sourceVideoUrl);
        } catch (error) {
          // Agents rarely made the copy themselves after this rejection, so make it here.
          if (
            !(error instanceof ApiRequestError) ||
            error.status !== 422 ||
            !error.message.includes('must be hosted in sync. labs storage')
          )
            throw error;
          const copy = await copyToSyncStorage(input, context?.signal);
          try {
            return { ...object.parse(await start(copy.url)), videoAssetId: copy.id };
          } catch (retryError) {
            // Name the saved copy so a retry transcribes it instead of copying again.
            if (retryError instanceof Error)
              retryError.message += ` The video is saved in Sync storage as asset ${copy.id}; retry with videoAssetId ${copy.id}.`;
            throw retryError;
          }
        }
      },
    },
    {
      name: 'dialogue-transcriptions_get',
      title: 'Check an Edit Dialogue transcription',
      description: DIALOGUE_TEXT['dialogue-transcriptions_get'].description,
      inputSchema: sourceSchema.extend({
        projectId: sourceSchema.shape.projectId.describe(
          DIALOGUE_TEXT['dialogue-transcriptions_get'].params.projectId,
        ),
        videoAssetId: sourceSchema.shape.videoAssetId.describe(
          DIALOGUE_TEXT['dialogue-transcriptions_get'].params.videoAssetId,
        ),
        id: transcriptionIdInput.describe(DIALOGUE_TEXT['dialogue-transcriptions_get'].params.id),
      }).shape,
      annotations: readHints,
      handler: (args, context) => checkedJob(readTranscript, args, context?.signal),
    },
    {
      name: 'dialogue-previews_create',
      title: 'Preview dialogue edits',
      description: DIALOGUE_TEXT['dialogue-previews_create'].description,
      inputSchema: sourceSchema.extend({
        projectId: sourceSchema.shape.projectId.describe(
          DIALOGUE_TEXT['dialogue-previews_create'].params.projectId,
        ),
        videoAssetId: sourceSchema.shape.videoAssetId.describe(
          'Saved VIDEO asset for the transcription or prior preview, accessible to the connected account.',
        ),
        idempotencyKey: previewKeySchema
          .optional()
          .describe(
            'Persist a unique key before creation when dialogue_get-options reports keyedPreview. Reuse only with identical inputs for an explicitly requested retry.',
          ),
        transcriptionJobId: z
          .uuid()
          .optional()
          .describe(DIALOGUE_TEXT['dialogue-previews_create'].params.transcriptionJobId),
        previousPreviewId: z
          .uuid()
          .optional()
          .describe(DIALOGUE_TEXT['dialogue-previews_create'].params.previousPreviewId),
        edits: dialogueEdits.describe(DIALOGUE_TEXT['dialogue-previews_create'].params.edits),
        transcriptionId: z
          .uuid()
          .optional()
          .describe('Deprecated alias of transcriptionJobId.')
          .meta({ deprecated: true }),
      }).shape,
      annotations: { ...writeHints, openWorldHint: false },
      handler: async (args, context) => {
        const key = previewKeySchema.optional().parse(args.idempotencyKey);
        if (key && !keyedPreview)
          throw new Error('This API does not support keyed dialogue preview recovery.');
        const transcriptionId = transcriptionJobId(args);
        if (Boolean(transcriptionId) === Boolean(args.previousPreviewId)) {
          throw new Error('Provide one transcriptionJobId or previousPreviewId, not both.');
        }
        const input = await source(args, context?.signal);
        const previous = args.previousPreviewId
          ? await checkedJob(readPreview, { ...args, id: args.previousPreviewId }, context?.signal)
          : undefined;
        const transcriptJob =
          previous ??
          (await checkedJob(readTranscript, { ...args, id: transcriptionId }, context?.signal));
        if (
          transcriptJob.status !== 'COMPLETED' &&
          !(previous && transcriptJob.status === 'COMPLETED_PARTIAL')
        )
          throw new Error('Wait for the source transcript to finish.');
        const body = z.object(preview.inputSchema).parse({
          // Job snapshots retain the immutable source identity across rotating asset signatures.
          sourceVideoUrl: z.url().parse(transcriptJob.sourceVideoUrl),
          projectId: input.projectId,
          transcript: previous ? previous.sourceTranscript : transcriptJob.transcript,
          edits: args.edits,
          ...(previous?.voiceId ? { voiceId: previous.voiceId } : {}),
          ...(previous ? {} : { transcriptionJobId: transcriptionId }),
          ...(previous && JSON.stringify(previous.edits) === JSON.stringify(args.edits)
            ? { rerunOfJobId: previous.id }
            : {}),
        });
        return httpClient.request('post', paths[2]!, {
          body,
          ...(key ? { headers: { 'Idempotency-Key': key } } : {}),
          signal: context?.signal,
        });
      },
    },
    {
      name: 'dialogue-previews_get',
      title: 'Check a dialogue edit preview',
      description: DIALOGUE_TEXT['dialogue-previews_get'].description,
      inputSchema: sourceSchema.extend({
        projectId: sourceSchema.shape.projectId.describe(
          DIALOGUE_TEXT['dialogue-previews_get'].params.projectId,
        ),
        videoAssetId: sourceSchema.shape.videoAssetId.describe(
          DIALOGUE_TEXT['dialogue-previews_get'].params.videoAssetId,
        ),
        id: previewId.describe(DIALOGUE_TEXT['dialogue-previews_get'].params.id),
      }).shape,
      annotations: readHints,
      handler: (args, context) => checkedJob(readPreview, args, context?.signal),
    },
    {
      name: 'dialogue-videos_estimate',
      title: 'Estimate an edited dialogue video',
      description: estimateText.description,
      inputSchema: generationSchema.shape,
      annotations: readHints,
      handler: async (args, context) =>
        httpClient.request('post', '/v2/analyze/cost', {
          body: await generationBody(args, context?.signal),
          signal: context?.signal,
        }),
    },
    {
      name: 'dialogue-videos_create',
      title: 'Create the edited dialogue video',
      description: DIALOGUE_TEXT['dialogue-videos_create'].description,
      inputSchema: generationSchema.extend({
        projectId: sourceSchema.shape.projectId.describe(
          DIALOGUE_TEXT['dialogue-videos_create'].params.projectId,
        ),
        videoAssetId: sourceSchema.shape.videoAssetId.describe(
          'Saved VIDEO asset used for the approved dialogue preview, accessible to the connected account.',
        ),
        dialogueEditId: generationSchema.shape.dialogueEditId.describe(
          'Completed Edit Dialogue audio preview ID for this source video and the current user-approved edits. Not a transcription or generation ID.',
        ),
        model: generationSchema.shape.model.describe(
          'Lip-sync model returned by models_list, matching the approved estimate.',
        ),
        continuation: generationContextSchema
          .optional()
          .describe(
            'Only for an explicitly requested continuation of an existing generation in this project. The workflow must be edit_dialogue.',
          ),
        idempotencyKey: z
          .string()
          .regex(/^[A-Za-z0-9._~-]{1,128}$/)
          .describe(
            'Persist one unique key per approved generation. Reuse the exact key and unchanged inputs when recovering an uncertain response; never automatically generate a replacement key.',
          ),
      }).shape,
      outputSchema: generationOutputSchema,
      annotations: { ...writeHints, openWorldHint: false },
      handler: async (args, context) => {
        const key = z
          .string()
          .regex(/^[A-Za-z0-9._~-]{1,128}$/)
          .parse(args.idempotencyKey);
        const lineage = await generationContextHeaders(
          httpClient,
          args,
          ['edit_dialogue'],
          context?.signal,
        );
        return httpClient.request('post', '/v2/generate', {
          body: await generationBody(args, context?.signal),
          headers: { ...lineage, 'Idempotency-Key': key },
          signal: context?.signal,
        });
      },
    },
  ];
}
