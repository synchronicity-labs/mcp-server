import { z } from 'zod';
import { type ClientProfile, resolveClientProfile } from '../client-profile.js';
import type { HttpClient } from '../http-client.js';
import { schemaProperty } from '../openapi/parser.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';
import { modelOptionsSchema, parseModelOptions } from './model-options.js';
import { generationOutputSchema } from './output-schemas.js';
import {
  assertProjectDestination,
  createProjectId,
  newProjectFields,
} from './project-destination.js';

const seconds = z.number().finite().nonnegative();
const frame = z.number().int().nonnegative();
// How Studio sets the face a clip lipsyncs: a point on it or a face track,
// both counted from the clip's own first frame, or automatic detection.
const speaker = z.union([
  z
    .object({
      frameNumber: frame.describe(
        'Frame of this clip, counted from its first frame, showing the face.',
      ),
      x: z
        .number()
        .finite()
        .describe(
          'Pixel x on the face in that frame of the video. A point off the face (even on the hair) rejects the whole generation, so aim at the face centre.',
        ),
      y: z.number().finite().describe('Pixel y on the face in that frame of the video.'),
    })
    .strict(),
  z
    .object({
      faceTrackUrl: z
        .url({ protocol: /^https$/ })
        .describe('HTTPS URL of a JSON face track: one bounding box per frame of this clip.'),
    })
    .strict(),
  z
    .object({
      detect: z.literal(true).describe('Detect the speaking face in this clip automatically.'),
    })
    .strict(),
]);
const clip = z
  .object({
    audioAssetId: z
      .uuid()
      .optional()
      .describe('Sync asset id of the audio clip. Give audioAssetId or audioUrl.'),
    audioUrl: z
      .url({ protocol: /^https$/ })
      .optional()
      .describe(
        'HTTPS URL of the audio instead of an asset, such as a completed translation preview’s outputMediaUrl.',
      ),
    startTime: seconds
      .optional()
      .describe(
        'Second on the video where this clip starts. Give startTime and endTime, or startFrame and endFrame.',
      ),
    endTime: seconds.optional().describe('Second on the video where this clip ends.'),
    startFrame: frame
      .optional()
      .describe('First frame of the video this clip covers, used when its speaker is picked.'),
    endFrame: frame.optional().describe('Last frame of the video this clip covers, inclusive.'),
    audioStartTime: seconds
      .optional()
      .describe('Second into the audio file this clip plays from. Omit to start at 0.'),
    audioEndTime: seconds
      .optional()
      .describe('Second into the audio file this clip plays to. Omit to play on from the start.'),
    syncMode: modelOptionsSchema.shape.sync_mode.describe(
      'How this clip fits when its audio and video lengths differ. Omit to use options.sync_mode.',
    ),
    speaker: speaker
      .optional()
      .describe(
        'The face this clip lipsyncs: a point on it in one of the clip’s frames, a face track, or automatic detection. Omit to use options.active_speaker_detection.',
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

type Span = { start: number; end: number; index: number; unit: 'seconds' | 'frames' };

/** A clip's stretch of the video, in seconds or in frames (end inclusive). */
function spanOf({ startTime, endTime, startFrame, endFrame }: Clip, index: number): Span {
  const given = [startTime, endTime, startFrame, endFrame].filter((v) => v !== undefined).length;
  if (given === 2 && startTime !== undefined && endTime !== undefined)
    return { unit: 'seconds', start: startTime, end: endTime, index };
  if (given === 2 && startFrame !== undefined && endFrame !== undefined)
    return { unit: 'frames', start: startFrame, end: endFrame + 1, index };
  throw new Error(
    `clips[${index}]: give startTime and endTime, or startFrame and endFrame, not a mix.`,
  );
}

function describeSpan(span: Span): string {
  return span.unit === 'frames'
    ? `frames ${span.start}-${span.end - 1}`
    : `seconds ${span.start}-${span.end}`;
}

/** Clips must have a positive span and may not share any part of the video. */
function assertPlaceable(clips: Clip[], maxClips?: number): void {
  if (maxClips !== undefined && clips.length > maxClips)
    throw new Error(
      `A generation takes at most ${maxClips} clips; this request has ${clips.length}. Merge neighbouring clips of the same face, or split the video into parts.`,
    );
  const byUnit = { seconds: [] as Span[], frames: [] as Span[] };
  clips.forEach((c, index) => {
    if ((c.audioAssetId === undefined) === (c.audioUrl === undefined))
      throw new Error(`clips[${index}]: give audioAssetId or audioUrl, exactly one.`);
    const span = spanOf(c, index);
    if (span.end <= span.start + (span.unit === 'frames' ? 1 : 0))
      throw new Error(`clips[${index}] (${describeSpan(span)}) must end after it starts.`);
    if (c.audioEndTime !== undefined && c.audioEndTime <= (c.audioStartTime ?? 0))
      throw new Error(
        `clips[${index}]: audioEndTime must be after audioStartTime, which defaults to 0.`,
      );
    if (
      span.unit === 'frames' &&
      c.speaker &&
      'frameNumber' in c.speaker &&
      c.speaker.frameNumber >= span.end - span.start
    )
      throw new Error(
        `clips[${index}]: speaker.frameNumber ${c.speaker.frameNumber} is not one of its ${span.end - span.start} frames; it counts from the clip’s first frame (0), not the video’s.`,
      );
    byUnit[span.unit].push(span);
  });
  for (const spans of Object.values(byUnit)) {
    const sorted = spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const [previous, current] = [sorted[i - 1]!, sorted[i]!];
      if (current.start < previous.end)
        throw new Error(
          `clips[${previous.index}] (${describeSpan(previous)}) and clips[${current.index}] (${describeSpan(current)}) overlap; each part of the video takes one clip, so end one before the other starts.`,
        );
    }
  }
}

/** Per-clip settings, in the shape the API's segment override takes. */
function clipOverride({ syncMode, speaker: face }: Clip) {
  const detection =
    face === undefined
      ? undefined
      : 'detect' in face
        ? { auto_detect: true }
        : 'faceTrackUrl' in face
          ? { auto_detect: false, bounding_boxes_url: face.faceTrackUrl }
          : { auto_detect: false, frame_number: face.frameNumber, coordinates: [face.x, face.y] };
  if (syncMode === undefined && detection === undefined) return {};
  return {
    optionsOverride: {
      ...(syncMode === undefined ? {} : { sync_mode: syncMode }),
      ...(detection === undefined ? {} : { active_speaker_detection: detection }),
    },
  };
}

/**
 * Lipsyncs one video with several audio clips placed at given times, the shape
 * of a Studio timeline. Each distinct audio asset becomes one input, and each
 * clip a segment that reads its part of that audio.
 */
export function generationBody(args: z.infer<typeof input>, projectId: string) {
  // One input per distinct audio, keyed by asset id or URL.
  const audioKey = (c: Clip) => (c.audioAssetId ? `asset:${c.audioAssetId}` : `url:${c.audioUrl}`);
  const refs = new Map<string, string>();
  for (const c of args.clips)
    if (!refs.has(audioKey(c))) refs.set(audioKey(c), `audio-${refs.size + 1}`);
  const model = args.model ?? 'sync-3';
  const options = parseModelOptions(args.options, { model });
  return {
    model,
    ...(options === undefined ? {} : { options }),
    input: [
      { type: 'video', assetId: args.videoAssetId },
      ...[...refs].map(([key, refId]) =>
        key.startsWith('asset:')
          ? { type: 'audio', assetId: key.slice('asset:'.length), refId }
          : { type: 'audio', url: key.slice('url:'.length), refId },
      ),
    ],
    segments: args.clips.map((c) => ({
      ...(c.startFrame === undefined
        ? { startTime: c.startTime, endTime: c.endTime }
        : { startFrame: c.startFrame, endFrame: c.endFrame }),
      audioInput: {
        refId: refs.get(audioKey(c))!,
        ...(c.audioStartTime === undefined ? {} : { startTime: c.audioStartTime }),
        ...(c.audioEndTime === undefined ? {} : { endTime: c.audioEndTime }),
      },
      ...clipOverride(c),
    })),
    projectId,
  };
}

/** segments.maxItems on POST /v2/generate, when the API's spec publishes it. */
export function timelineClipLimit(operations: ParsedOperation[]): number | undefined {
  const generate = operations.find(
    (operation) => operation.method === 'post' && operation.path === '/v2/generate',
  );
  const segments = generate?.requestBody && schemaProperty(generate.requestBody.schema, 'segments');
  const limit = segments?.maxItems;
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

export function createTimelineLipsyncTool(
  httpClient: HttpClient,
  getProfile: () => ClientProfile = () => resolveClientProfile(),
  // The API's segment limit, read from its spec when it publishes one.
  maxClips?: number,
): McpToolDefinition {
  return {
    name: 'create-timeline-lipsync',
    title: 'Create timeline lipsync',
    description:
      'Lipsync one video with several audio clips placed at given times, like a Studio timeline. Each clip names a Sync audio asset or audio URL, the seconds (or frames) of the video it covers, and optionally the part of the audio file it plays, its sync mode and the face it lipsyncs. Parts of the video no clip covers keep their original picture and sound, so leave a gap wherever the user wants no lipsync. For one audio across the whole video, use create-lipsync. Defaults to sync-3 and, unless projectId names a project the user picked, a new project; a keyed request without projectId needs a fresh projectCreationKey. Estimate and confirm before creating; this starts an asynchronous generation and returns its id. Poll it with generate_get-generation and wait: true. Clips are checked before anything is created, and errors name the clip index.',
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
      assertPlaceable(args.clips, maxClips);

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
