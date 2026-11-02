import { z } from 'zod';
import { type ClientProfile, resolveClientProfile } from '../client-profile.js';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';
import { modelOptionsSchema, parseModelOptions } from './model-options.js';
import { generationOutputSchema } from './output-schemas.js';
import {
  assertProjectDestination,
  createProjectId,
  newProjectFields,
} from './project-destination.js';

const seconds = z.number().finite().nonnegative();
const clip = z
  .object({
    audioAssetId: z.uuid().describe('Sync asset id of the audio clip.'),
    startTime: seconds.describe('Second on the video where this clip starts.'),
    endTime: seconds.describe('Second on the video where this clip ends.'),
    audioStartTime: seconds
      .optional()
      .describe('Second into the audio file this clip plays from. Omit to start at 0.'),
    audioEndTime: seconds
      .optional()
      .describe('Second into the audio file this clip plays to. Omit to play on from the start.'),
    syncMode: modelOptionsSchema.shape.sync_mode.describe(
      'How this clip fits when its audio and video lengths differ. Omit to use options.sync_mode.',
    ),
  })
  .strict();
const input = z
  .object({
    videoAssetId: z.uuid().describe('Sync asset id of the video.'),
    clips: z
      .array(clip)
      .min(1)
      .max(200)
      .describe(
        'Audio clips placed on the video, in any order, without overlapping. Parts of the video no clip covers keep their original picture and sound.',
      ),
    model: z.string().trim().min(1).optional().describe('Model to use. Defaults to sync-3.'),
    options: modelOptionsSchema.optional(),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9._~-]{1,128}$/)
      .optional()
      .describe(
        'Unique key for this generation. Reuse it with identical arguments when retrying after a lost response. Passed as the Idempotency-Key header.',
      ),
    ...newProjectFields,
    projectId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Existing Sync project id, only for a project the user explicitly selected or one just created for this request.',
      ),
    projectName: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Name for a NEW project only. Never search or reuse a matching name. Cannot be combined with projectId.',
      ),
  })
  .strict();

type Clip = z.infer<typeof clip>;

/** Clips must have a positive span and may not share any part of the video. */
function assertPlaceable(clips: Clip[]): void {
  for (const { startTime, endTime, audioStartTime, audioEndTime } of clips) {
    if (endTime <= startTime) throw new Error('Each clip must end after it starts.');
    if (audioEndTime !== undefined && audioEndTime <= (audioStartTime ?? 0))
      throw new Error(
        'Each clip’s audioEndTime must be after its audioStartTime, which defaults to 0.',
      );
  }
  const sorted = [...clips].sort((a, b) => a.startTime - b.startTime);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.startTime < sorted[i - 1]!.endTime)
      throw new Error('Clips overlap on the video; each part of the video takes one clip.');
  }
}

/**
 * Lipsyncs one video with several audio clips placed at given times, the shape
 * of a Studio timeline. Each distinct audio asset becomes one input, and each
 * clip a segment that reads its part of that audio.
 */
export function generationBody(args: z.infer<typeof input>, projectId: string) {
  const refs = new Map<string, string>();
  for (const { audioAssetId } of args.clips)
    if (!refs.has(audioAssetId)) refs.set(audioAssetId, `audio-${refs.size + 1}`);
  const options = parseModelOptions(args.options);
  return {
    model: args.model ?? 'sync-3',
    ...(options === undefined ? {} : { options }),
    input: [
      { type: 'video', assetId: args.videoAssetId },
      ...[...refs].map(([assetId, refId]) => ({ type: 'audio', assetId, refId })),
    ],
    segments: args.clips.map((c) => ({
      startTime: c.startTime,
      endTime: c.endTime,
      audioInput: {
        refId: refs.get(c.audioAssetId)!,
        ...(c.audioStartTime === undefined ? {} : { startTime: c.audioStartTime }),
        ...(c.audioEndTime === undefined ? {} : { endTime: c.audioEndTime }),
      },
      ...(c.syncMode === undefined ? {} : { optionsOverride: { sync_mode: c.syncMode } }),
    })),
    projectId,
  };
}

export function createTimelineLipsyncTool(
  httpClient: HttpClient,
  getProfile: () => ClientProfile = () => resolveClientProfile(),
): McpToolDefinition {
  return {
    name: 'create-timeline-lipsync',
    title: 'Create timeline lipsync',
    description:
      'Lipsync one video with several audio clips placed at given times, like a Studio timeline. Each clip names a Sync audio asset, the seconds on the video it covers, and optionally the part of the audio file it plays and its sync mode. Parts of the video no clip covers keep their original picture and sound, so leave a gap wherever the user wants no lipsync. For one audio across the whole video, use create-lipsync. Defaults to sync-3 and, unless projectId names a project the user picked, a new project; a keyed request without projectId needs a fresh projectCreationKey. Estimate and confirm before creating; this starts an asynchronous generation and returns its id. Poll it with generate_get-generation.',
    inputSchema: input.shape,
    outputSchema: generationOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    meta: {
      'openai/toolInvocation/invoking': 'Creating your timeline lipsync…',
      'openai/toolInvocation/invoked': 'Timeline lipsync started.',
    },
    handler: async (rawArgs, context) => {
      const signal = context?.signal;
      const args = input.parse(rawArgs);
      assertProjectDestination(args.projectId, args.projectName, args.projectCreationKey);
      assertPlaceable(args.clips);

      // Like create-lipsync: a new project unless the user picked one.
      const projectId =
        args.projectId ??
        (await createProjectId(
          httpClient,
          {
            name: args.projectName ?? (context?.clientProfile ?? getProfile()).defaultProjectName,
            projectCreationKey: args.projectCreationKey,
            idempotencyKey: args.idempotencyKey,
            defaultWorkflow: 'lipsync',
          },
          signal,
        ));
      signal?.throwIfAborted();
      return httpClient.request('post', '/v2/generate', {
        signal,
        ...(args.idempotencyKey ? { headers: { 'Idempotency-Key': args.idempotencyKey } } : {}),
        body: generationBody(args, projectId),
      });
    },
  };
}
