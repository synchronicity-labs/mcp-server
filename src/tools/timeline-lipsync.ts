import { z } from 'zod';
import { type ClientProfile, resolveClientProfile } from '../client-profile.js';
import type { HttpClient } from '../http-client.js';
import { schemaProperty } from '../openapi/parser.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';
import { parseLipsyncOptions, timelineShotsInput } from './lipsync-shots.js';
import { modelOptionsSchema } from './model-options.js';
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
    shots: timelineShotsInput,
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

// Offered only when the API publishes segments[].lipsync and outputAudio.
const keptClip = clip.extend({
  lipsync: z
    .literal(false)
    .optional()
    .describe(
      'false keeps this part of the video exactly as it is: not lipsynced and not billed, while outputAudio still plays over it. Give no audio, syncMode or speaker. Use it for shots that should hear the dub without moving lips (listeners, people off camera or facing away).',
    ),
});
const outputAudio = z
  .object({
    audioAssetId: z.uuid().optional().describe('Sync asset id of the audio.'),
    audioUrl: z
      .url({ protocol: /^https$/ })
      .optional()
      .describe('HTTPS URL of the audio.'),
  })
  .strict()
  .describe(
    'One audio that plays over the whole finished output from its first second, replacing the sound of every part, such as the full dubbed track. Defaults, when a clip sets lipsync: false, to the only audio the clips use.',
  );
const keptInput = input.extend({
  clips: z
    .array(keptClip)
    .min(1)
    .max(200)
    .describe(
      'Clips placed on the video, in any order, without overlapping. Parts no clip covers keep their original picture, and their original sound unless outputAudio plays; clips with lipsync: false keep their picture but play outputAudio.',
    ),
  outputAudio: outputAudio.optional(),
});

type Clip = z.infer<typeof keptClip>;
type TimelineInput = z.infer<typeof keptInput>;

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
  if (clips.every((c) => c.lipsync === false))
    throw new Error('Every clip sets lipsync: false, so there is nothing to lipsync.');
  clips.forEach((c, index) => {
    const kept = c.lipsync === false;
    if (
      kept &&
      [c.audioAssetId, c.audioUrl, c.audioStartTime, c.audioEndTime, c.syncMode, c.speaker].some(
        (value) => value !== undefined,
      )
    )
      throw new Error(
        `clips[${index}] sets lipsync: false, so it takes no audio, syncMode or speaker; outputAudio plays there.`,
      );
    if (!kept && (c.audioAssetId === undefined) === (c.audioUrl === undefined))
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
export function generationBody(
  args: TimelineInput,
  projectId: string,
  options: ReturnType<typeof parseLipsyncOptions>,
) {
  // One input per distinct audio, keyed by asset id or URL.
  const audioKey = (c: { audioAssetId?: string; audioUrl?: string }) =>
    c.audioAssetId ? `asset:${c.audioAssetId}` : `url:${c.audioUrl}`;
  const refs = new Map<string, string>();
  const audios = [
    ...args.clips.filter((placed) => placed.lipsync !== false),
    ...(args.outputAudio ? [args.outputAudio] : []),
  ];
  for (const audio of audios)
    if (!refs.has(audioKey(audio))) refs.set(audioKey(audio), `audio-${refs.size + 1}`);
  return {
    model: args.model ?? 'sync-3',
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
      ...(c.lipsync === false ? { lipsync: false } : audioPart(c)),
    })),
    ...outputAudioPart(),
    projectId,
  };

  // Kept clips need one track over the whole output: outputAudio, or the only audio the clips
  // use. Sent explicitly so the request says which track plays, not the API's default.
  function outputAudioPart() {
    if (args.outputAudio) return { outputAudio: { refId: refs.get(audioKey(args.outputAudio))! } };
    if (args.clips.some((placed) => placed.lipsync === false) && refs.size === 1)
      return { outputAudio: { refId: [...refs.values()][0]! } };
    return {};
  }

  function audioPart(c: Clip) {
    return {
      audioInput: {
        refId: refs.get(audioKey(c))!,
        ...(c.audioStartTime === undefined ? {} : { startTime: c.audioStartTime }),
        ...(c.audioEndTime === undefined ? {} : { endTime: c.audioEndTime }),
      },
      ...clipOverride(c),
    };
  }
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

/** Whether the API takes segments[].lipsync: false and a top-level outputAudio. */
export function timelineKeepsClips(operations: ParsedOperation[]): boolean {
  const generate = operations.find(
    (operation) => operation.method === 'post' && operation.path === '/v2/generate',
  );
  const body = generate?.requestBody?.schema;
  const segment = schemaProperty(body, 'segments')?.items as Parameters<typeof schemaProperty>[0];
  return !!schemaProperty(segment, 'lipsync') && !!schemaProperty(body, 'outputAudio');
}

export function createTimelineLipsyncTool(
  httpClient: HttpClient,
  getProfile: () => ClientProfile = () => resolveClientProfile(),
  // Read from the API's spec: its segment limit, and whether clips can be kept.
  features: { maxClips?: number; keptClips?: boolean } = {},
): McpToolDefinition {
  const schema = features.keptClips ? keptInput : input;
  return {
    name: 'lipsync_create-timeline',
    title: 'Create timeline lipsync',
    description: [
      'Lipsync one saved video with several audio clips, each on its own stretch of the video like a Studio timeline: to lipsync only some ranges, or to switch audio or speaker between shots. For one audio across the whole video use lipsync_create; to translate and dub a whole video use dubbing_create when available.',
      `Each lipsynced clip takes exactly one of audioAssetId or audioUrl, a span in seconds or in frames (not a mix), and optionally audioStartTime and audioEndTime to play part of that audio. Clips may come in any order but must not overlap; parts no clip covers keep their original picture and${features.keptClips ? ', unless outputAudio plays,' : ''} their original sound. Frame spans need the video's fps: read it from assets_get-playback-metadata when it returns one (signed-in users only) and never guess it; otherwise use seconds. Get speaker.faceTrackUrl from transcriptions_slice-speaker-face-track when available.`,
      ...(features.keptClips
        ? [
            'To lipsync only the speaking shots of a dub, pass the full dubbed track as outputAudio, give speaking shots clips that play their part of it, and mark the other shots lipsync: false. outputAudio replaces the sound of the whole output; if it is omitted while a clip sets lipsync: false, the one audio the other clips share plays instead, so pass it whenever they use several.',
          ]
        : []),
      'Before anything is created, the tool validates the input (options included), spans, audio ranges and overlaps, and per-clip errors name the clip index. Overlaps are compared only within one unit, so use one unit for every clip. Problems only the API detects, such as an unknown audio asset or a speaker point off the face, surface after a new project may already exist.',
      'Paid generation, sync-3 unless model is set. Estimate and confirm before creating; this starts an asynchronous generation and returns its id and status. Poll that id with generations_get and wait: true.',
      'Without projectId it first creates a NEW project, named projectName or a default; default new work to that. Pass projectId with projectIntent=explicit only when the user explicitly asks to work in that project, selects it in the interface, or it was just created for this request; a matching workflow or name or an open editor is never permission to modify it. Send a fresh idempotencyKey, plus a fresh projectCreationKey when there is no projectId, and after a lost or uncertain response retry only with identical arguments and the same keys. Never resend a request that had no idempotencyKey: it can start a second paid generation.',
    ].join('\n\n'),
    inputSchema: schema.shape,
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
      const args: TimelineInput = schema.parse(rawArgs);
      assertProjectDestination(args.projectId, args.projectName, args.projectCreationKey);
      assertPlaceable(args.clips, features.maxClips);
      if (
        args.outputAudio &&
        (args.outputAudio.audioAssetId === undefined) === (args.outputAudio.audioUrl === undefined)
      )
        throw new Error('outputAudio: give audioAssetId or audioUrl, exactly one.');
      // Before any project exists, so a bad shot list creates nothing.
      const options = parseLipsyncOptions(args, { model: args.model ?? 'sync-3' });

      // Like lipsync_create: a new project unless the user picked one.
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
        body: generationBody(args, projectId, options),
      });
    },
  };
}
