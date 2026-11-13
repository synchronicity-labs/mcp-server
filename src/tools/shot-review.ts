import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import { whenEnabled } from './asset-analysis.js';
import type { McpToolDefinition } from './generator.js';
import { pollUntil, waitInput } from './job-wait.js';
import { generationOutputSchema } from './output-schemas.js';

/**
 * Shot review: render chosen shots of a finished generation again, then build one video
 * that keeps the first render everywhere else. The splice routes are internal and behind
 * lipsync_planning, like the shots input, so both tools are listed only to accounts with
 * that feature (account-features.ts); the API stays the authority on a call.
 */

const startFrame = z
  .number()
  .int()
  .nonnegative()
  .describe('First frame of the shot, counted from 0 at the video’s first frame.');
const endFrame = z
  .number()
  .int()
  .positive()
  .describe('Frame after the shot’s last one (exclusive): the next shot’s startFrame.');

type Range = { startFrame: number; endFrame: number };

/** Ranges in video order that never overlap; the error names the first that does not fit. */
function assertOrdered(ranges: Range[], name: string): void {
  let previousEnd = 0;
  ranges.forEach((range, index) => {
    if (range.endFrame <= range.startFrame)
      throw new Error(`${name}[${index}].endFrame must be after its startFrame (exclusive end).`);
    if (range.startFrame < previousEnd)
      throw new Error(
        `${name}[${index}].startFrame must be at or after the previous endFrame (${previousEnd}): give them in video order, without overlaps.`,
      );
    previousEnd = range.endFrame;
  });
}

// The fields of GET /v2/generate/{id} a new take is built from.
const media = z.object({
  type: z.string(),
  assetId: z.uuid().nullish(),
  url: z.string().nullish(),
});
const baseGeneration = z.object({
  id: z.uuid(),
  status: z.string(),
  model: z.string().min(1),
  projectId: z.uuid().nullish(),
  input: z.array(media),
  dubAudioAssetId: z.uuid().nullish(),
  outputDuration: z.number().nullish(),
  segments: z.array(z.unknown()).nullish(),
  speakers: z.array(z.unknown()).nullish(),
});

const source = (item: z.infer<typeof media>) =>
  item.assetId ? { assetId: item.assetId } : item.url ? { url: item.url } : undefined;

function createRegenerateTool(http: HttpClient): McpToolDefinition {
  const input = z
    .object({
      generationId: z
        .uuid()
        .describe('Id of the completed generation whose shots looked wrong: the first render.'),
      shots: z
        .array(
          z
            .object({
              startFrame,
              endFrame,
              detectSpeaker: z
                .boolean()
                .optional()
                .describe(
                  'true when the wrong person’s mouth moved in this shot: Sync works out again who is speaking.',
                ),
              occlusionDetection: z
                .boolean()
                .optional()
                .describe(
                  'true when a hand, microphone or hair crossed the mouth in this shot: Sync keeps it in front of the lips.',
                ),
            })
            .strict(),
        )
        .min(1)
        .max(50)
        .describe(
          'The shots to render again, in video order and not overlapping. Use the boundaries the first render used: its shots input, or faces_get-timeline shots, as is.',
        ),
      fps: z
        .number()
        .positive()
        .describe(
          'Frame rate of the video, from faces_detect, faces_get-timeline, scenes_detect or assets_get-playback-metadata. It places each shot on the audio, so never guess it.',
        ),
      frameCount: z
        .number()
        .int()
        .positive()
        .describe(
          'Frames in the video, from the same result as fps (frameCount, or the last scene’s endFrame + 1 from scenes_detect). It checks that the first render kept the video’s length.',
        ),
      idempotencyKey: z
        .string()
        .min(1)
        .optional()
        .describe(
          'A fresh key for this request. After a lost or uncertain response, retry only with identical arguments and the same key.',
        ),
    })
    .strict();
  return {
    name: 'shots_regenerate',
    title: 'Render shots of a generation again',
    description: [
      'Render some shots of a finished lipsync or dub again, when the user says which shots look wrong. It lipsyncs only those shots, from the same video and the same audio as the first render (the dubbed track, for a dub), and returns a new generation: a whole-length video with the new shots in place and the original, unsynced picture everywhere else. That video is one take, not the result: once the user picked the takes, build the final video with shots_splice.',
      'Give each shot the frames the first render used and say what was wrong with it: detectSpeaker when the wrong person’s mouth moved, occlusionDetection when something crossed the mouth. A shot with neither is simply rendered again. Works on a generation made from one video and one audio, or a dub; one made from a script, a timeline or several speakers cannot be re-rendered this way. The first render must run as long as the video: when its audio was shorter or longer, the video was cut, looped or retimed, a new take would not line up with it, and the tool starts nothing.',
      'Paid generation, billed for the listed shots only, not the whole video. Estimate and confirm before creating; this starts an asynchronous generation in the first render’s project and returns its id and status. Poll that id with generations_get and wait: true.',
    ].join('\n\n'),
    inputSchema: input.shape,
    outputSchema: generationOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (rawArgs, context) => {
      const args = input.parse(rawArgs);
      assertOrdered(args.shots, 'shots');
      const last = args.shots.at(-1)!;
      if (last.endFrame > args.frameCount)
        throw new Error(
          `shots[${args.shots.length - 1}].endFrame is past the video's last frame (frameCount ${args.frameCount}).`,
        );
      const signal = context?.signal;
      const base = baseGeneration.parse(
        await http.request('get', `/v2/generate/${args.generationId}`, { signal }),
      );
      if (base.status !== 'COMPLETED')
        throw new Error(
          `Generation ${base.id} is ${base.status}. Shots can be rendered again once it is COMPLETED.`,
        );
      if (base.segments?.length || base.speakers?.length)
        throw new Error(
          'This generation was made from timeline clips or several speakers. Render its shots again with lipsync_create-timeline instead.',
        );
      // A take is rendered on the untouched video, so it lines up with the first render
      // only when that render kept the video's length. An unknown length is not a match.
      const videoSeconds = args.frameCount / args.fps;
      if (base.outputDuration == null)
        throw new Error(
          'Sync did not report how long the first render runs, so it cannot be checked against the video. Redo the whole lipsync instead.',
        );
      if (Math.abs(base.outputDuration - videoSeconds) > Math.max(2 / args.fps, 0.1))
        throw new Error(
          `The first render runs ${base.outputDuration} s but the video runs ${Number(videoSeconds.toFixed(3))} s: its audio and video differed in length, so the video was cut, looped or retimed and a new take would not line up with it. Redo the whole lipsync instead.`,
        );
      const videoInput = base.input.find((item) => item.type === 'video');
      const video = videoInput && source(videoInput);
      if (!video) throw new Error('This generation has no video input to render shots from.');
      const audioInput = base.input.find((item) => item.type === 'audio');
      // A dub's own audio input is the source speech; its lipsync used the dubbed track.
      const audio = base.dubAudioAssetId
        ? { assetId: base.dubAudioAssetId }
        : audioInput && source(audioInput);
      if (!audio)
        throw new Error(
          'This generation has no saved audio to lipsync to (it was made from a script). Create the audio first, then use lipsync_create-timeline.',
        );
      signal?.throwIfAborted();
      return http.request('post', '/v2/generate', {
        signal,
        ...(args.idempotencyKey ? { headers: { 'Idempotency-Key': args.idempotencyKey } } : {}),
        body: {
          model: base.model,
          input: [
            { type: 'video', ...video },
            { type: 'audio', ...audio, refId: 'audio' },
          ],
          // Frames the segments leave out keep the source picture; only these are billed.
          // A segment's endFrame is inclusive, unlike a shot's; its audio end is a time.
          segments: args.shots.map((shot) => ({
            startFrame: shot.startFrame,
            endFrame: shot.endFrame - 1,
            audioInput: {
              refId: 'audio',
              startTime: shot.startFrame / args.fps,
              endTime: shot.endFrame / args.fps,
            },
            optionsOverride: {
              ...(shot.detectSpeaker ? { active_speaker_detection: { auto_detect: true } } : {}),
              ...(shot.occlusionDetection ? { occlusion_detection_enabled: true } : {}),
            },
          })),
          ...(base.projectId ? { projectId: base.projectId } : {}),
        },
      });
    },
  };
}

const replacement = z
  .object({
    generationId: z
      .uuid()
      .describe('The take to show in this range: a completed shots_regenerate generation.'),
    startFrame,
    endFrame,
  })
  .strict();
const spliceJobSchema = z.object({
  id: z.uuid().describe('Splice job ID.'),
  generationId: z.uuid().describe('The first render, the base of the video.'),
  replacements: z.array(replacement).describe('The ranges taken from other generations.'),
  status: z
    .enum(['pending', 'processing', 'completed', 'failed'])
    .describe(
      'pending: queued. processing: building the video. completed: the video asset exists. failed: see error; call again to retry.',
    ),
  assetId: z.uuid().nullable().describe('VIDEO asset with the final video. Null until completed.'),
  url: z.string().nullable().describe('URL of the final MP4. Null until completed.'),
  error: z
    .object({ code: z.string(), message: z.string() })
    .nullable()
    .describe('Why the job failed, such as generation_splice_mismatch. Null otherwise.'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const settled = (job: { status: string }) => job.status === 'completed' || job.status === 'failed';

function createSpliceTool(http: HttpClient): McpToolDefinition {
  const input = z
    .object({
      generationId: z
        .uuid()
        .describe('Id of the first render: every frame outside the ranges comes from it.'),
      replacements: z
        .array(replacement)
        .min(1)
        .max(500)
        .describe(
          'One range per shot whose new take the user accepted, in video order and not overlapping: the take’s generation id and the shot’s frames. Leave out a shot to keep the first render there.',
        ),
      wait: waitInput,
    })
    .strict();
  return {
    name: 'shots_splice',
    title: 'Build the final video from chosen takes',
    description:
      'Build the final video after a shot review: the first render everywhere, and inside each given range the frames of the take the user accepted. Saves it as a new VIDEO asset in the first render’s project and returns its assetId and url; the sound is the first render’s. Use it once the takes from shots_regenerate are COMPLETED and the user chose which to keep. ' +
      'Every generation must be a render of the same video: same frame count, frame rate and size, which a shots_regenerate take always is. Not billed. ' +
      'Sending the same ranges again returns the running or finished job, so calling again never builds the same video twice; different ranges build a new video once no other splice of this generation is running. It takes about as long as the video plays. Pass wait: true to wait on the server; while status is pending or processing, call again with wait: true.',
    inputSchema: input.shape,
    outputSchema: spliceJobSchema.shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: (rawArgs, context) =>
      whenEnabled('Shot review', async () => {
        const { generationId, replacements, wait } = input.parse(rawArgs);
        assertOrdered(replacements, 'replacements');
        const path = `/v2/generate/${generationId}/splice`;
        // The start route answers a repeat with the same job; polling reads instead, since
        // starts are limited to 60 an hour.
        let job = spliceJobSchema.parse(
          await http.request('post', path, { body: { replacements }, signal: context?.signal }),
        );
        if (wait && !settled(job))
          job = await pollUntil(
            async (signal) => spliceJobSchema.parse(await http.request('get', path, { signal })),
            settled,
            context,
            { describe: (splice) => `final video ${splice.status}` },
          );
        return job;
      }),
  };
}

export function createShotReviewTools(http: HttpClient): McpToolDefinition[] {
  return [createRegenerateTool(http), createSpliceTool(http)];
}
