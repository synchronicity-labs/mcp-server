import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import { whenEnabled } from './asset-analysis.js';
import type { McpToolDefinition } from './generator.js';
import { pollUntil, waitInput } from './job-wait.js';

/**
 * Face analysis of a video asset: the faces in each frame, and the shot, face-track and
 * speaker timeline a lipsync plan is made from. Like scenes and stems, the routes are
 * internal and behind a server flag, so they are written by hand and listed only to
 * accounts with the feature (account-features.ts). Agents select a face by a point: boxes
 * passed to a generation lower its quality.
 */

const assetId = z.uuid().describe('The VIDEO asset.');
const frame = z.number().int().nonnegative();
// Points, never boxes: boxes passed to a generation lower its quality.
const SELECT_A_FACE =
  'To lipsync one face, pass a point on it, never its boxes: the center of its box at one frame, as options.active_speaker_detection { frame_number, coordinates: [x, y] } on lipsync_create, where frame_number counts from the video’s first frame. In a segment override (a lipsync_create-timeline clip speaker, frameNumber with x and y), the frame counts from the segment’s first frame, so subtract the clip’s startFrame.';

const faceDataSchema = z.object({
  status: z
    .enum(['completed', 'pending', 'failed', 'not_requested'])
    .describe(
      'completed: the faces are read. pending: detection is running; call faces_detect with wait: true. failed: detection failed; faces_detect retries it. not_requested: call faces_detect to start it.',
    ),
  analysisRunId: z.uuid().nullable().describe('Analysis run the faces come from.'),
  error: z.string().nullable().describe('Why detection failed. Null otherwise.'),
  fps: z.number().nullable().describe('Frame rate of the video; null if unknown.'),
  frameCount: z.number().int().nullable().describe('Frames in the video; null if unknown.'),
  width: z.number().int().nullable().describe('Upright (displayed) frame width in pixels.'),
  height: z.number().int().nullable().describe('Upright (displayed) frame height in pixels.'),
});

const pixel = z.number().int();
const facesSchema = faceDataSchema.extend({
  frames: z
    .array(
      z.object({
        frame: frame.describe('Frame, counted from 0 at the video’s first frame.'),
        faces: z.array(
          z.object({
            trackId: z
              .string()
              .describe('Face track id, as in faces_get-timeline tracks; kept across frames.'),
            box: z
              .tuple([pixel, pixel, pixel, pixel])
              .describe('[x1, y1, x2, y2] in source pixels of the upright frame.'),
            center: z
              .tuple([pixel, pixel])
              .describe('Center of the box: the [x, y] to pass as coordinates.'),
          }),
        ),
      }),
    )
    .describe('Requested frames with the faces in each; empty unless completed.'),
});

// Every range is half-open, as the API stores it.
const range = {
  startFrame: frame.describe('First frame, counted from 0 at the video’s first frame.'),
  endFrame: frame.describe('Frame after the last one (exclusive).'),
};
const timelineSchema = faceDataSchema.extend({
  shots: z
    .array(z.object(range))
    .describe(
      'Camera shots in order; empty when the analysis has none. Pass them to lipsync_create shots as is.',
    ),
  tracks: z
    .array(
      z.object({
        trackId: z.string().describe('Face track id, as in faces_get and talking.trackId.'),
        personId: z
          .string()
          .nullable()
          .describe('Person the track was matched to across shots; null when unmatched.'),
        ...range,
        detectedFrames: z.number().int().describe('Frames of the track that have a box.'),
        faceHeight: z
          .object({ min: pixel, median: pixel })
          .nullable()
          .describe('Box height in upright source pixels; null when the track has no box.'),
        personSegments: z
          .array(z.object({ ...range, personId: z.string().nullable() }))
          .optional()
          .describe('Person per frame range; present only when the analysis split the track.'),
      }),
    )
    .describe('Face tracks: one face followed through consecutive frames.'),
  talking: z
    .array(
      z.object({
        ...range,
        speaker: z.string().nullable().describe('Voice speaking, as in voices; null for none.'),
        trackId: z
          .string()
          .nullable()
          .describe('Track judged to be talking; null when no visible face is.'),
        point: z
          .object({ frame, x: pixel, y: pixel })
          .nullable()
          .describe(
            'A point that selects the talking face: the center of its box at the detected frame nearest the middle of the range. Pass frame as frame_number and [x, y] as coordinates. Null when trackId is null or the track has no box in the range.',
          ),
        reason: z.string().describe('Why the analysis chose trackId, verbatim.'),
      }),
    )
    .describe('Who talks on screen, covering every frame in order.'),
  voices: z
    .array(
      z.object({
        startSeconds: z.number(),
        endSeconds: z.number(),
        type: z.enum(['speech', 'no_speech', 'overlap']),
        speakers: z.array(z.string()),
      }),
    )
    .describe('Speaker diarization of the audio, in seconds from the start.'),
});

const facesPath = (id: string) => `/v2/assets/${id}/faces`;
const annotations = (readOnlyHint: boolean) => ({
  readOnlyHint,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

function createDetectTool(http: HttpClient): McpToolDefinition {
  const input = z.object({ assetId, wait: waitInput });
  return {
    name: 'faces_detect',
    title: 'Detect faces in a video',
    description:
      'Start face and speaker analysis of a saved VIDEO asset, or report its status: completed, pending, failed or not_requested, with fps, frameCount and the upright frame size. It finds every visible face in every frame, follows each through the video as a face track, splits the video into camera shots and judges which face talks when. ' +
      'Starts only when the asset has no analysis or the last one failed, so calling again never reruns a finished one; an organization runs at most two at a time (429 beyond that). Pass wait: true to wait on the server; while status is pending, call again with wait: true. ' +
      'Once completed, read the result with faces_get-timeline when available (shots, tracks, who talks) and faces_get (boxes per frame).',
    inputSchema: input.shape,
    outputSchema: { assetId, ...faceDataSchema.shape },
    annotations: annotations(false),
    handler: (args, context) =>
      whenEnabled('Face detection', async () => {
        const { assetId: id, wait } = input.parse(args);
        // A read must name frames; frame 0 is enough for the status.
        const read = async (signal = context?.signal) =>
          faceDataSchema.parse(
            await http.request('get', facesPath(id), { query: { frame: '0' }, signal }),
          );
        // Read first: the start route allows 20 calls in 10 minutes.
        let state = await read();
        if (state.status === 'not_requested' || state.status === 'failed')
          state = faceDataSchema.parse(
            await http.request('post', facesPath(id), { signal: context?.signal }),
          );
        if (wait && state.status === 'pending')
          state = await pollUntil(read, (faces) => faces.status !== 'pending', context, {
            describe: (faces) => `face detection ${faces.status}`,
          });
        return { assetId: id, ...state };
      }),
  };
}

function createFacesTool(http: HttpClient): McpToolDefinition {
  const input = z.object({
    assetId,
    frame: frame.optional().describe('One frame, counted from 0. Or pass startFrame and endFrame.'),
    startFrame: frame.optional().describe('First frame of a range, counted from 0.'),
    endFrame: frame
      .optional()
      .describe('Frame after the last one in the range (exclusive), at most 250 after startFrame.'),
  });
  return {
    name: 'faces_get',
    title: 'Get the faces in video frames',
    description:
      'Read the faces faces_detect found in a saved VIDEO asset, for one frame or a range of at most 250 frames (frame, or startFrame and exclusive endFrame). Each face has its trackId, box and center. Frames count from 0 at the video’s first frame; boxes are [x1, y1, x2, y2] in source pixels of the upright (displayed) frame, the space of active_speaker_detection.coordinates. ' +
      `${SELECT_A_FACE} A face’s center is a safe point. ` +
      'frames is empty unless status is completed. For the whole video at once (shots, tracks and who talks) use faces_get-timeline when available.',
    inputSchema: input.shape,
    outputSchema: { assetId, ...facesSchema.shape },
    annotations: annotations(true),
    handler: (args, context) =>
      whenEnabled('Face detection', async () => {
        const { assetId: id, ...frames } = input.parse(args);
        const query = Object.fromEntries(
          Object.entries(frames).map(([key, value]) => [key, String(value)]),
        );
        const faces = facesSchema.parse(
          await http.request('get', facesPath(id), { query, signal: context?.signal }),
        );
        return { assetId: id, ...faces };
      }),
  };
}

function createTimelineTool(http: HttpClient): McpToolDefinition {
  const input = z.object({ assetId });
  return {
    name: 'faces_get-timeline',
    title: 'Get the face and speaker timeline of a video',
    description:
      'Read the analysis faces_detect made of a saved VIDEO asset, for planning a lipsync: camera shots, face tracks (person, frame range, detected frames, face height), which track talks in each frame range, and the voice timeline in seconds. Values are as the analysis stored them, without thresholds or smoothing. Arrays are empty unless status is completed. ' +
      'Frames count from 0 at the video’s first frame and every endFrame is exclusive (the next range starts there), unlike scenes_detect scenes and lipsync_create-timeline clips, whose endFrame is inclusive: a clip ends at endFrame - 1. ' +
      `Pass shots to lipsync_create as is to replace its own shot detection. Each talking range carries a point that selects its face; for any other frame, read the box center with faces_get. ${SELECT_A_FACE}`,
    inputSchema: input.shape,
    outputSchema: { assetId, ...timelineSchema.shape },
    annotations: annotations(true),
    handler: (args, context) =>
      whenEnabled('Face timeline', async () => {
        const { assetId: id } = input.parse(args);
        const timeline = timelineSchema.parse(
          await http.request('get', `${facesPath(id)}/timeline`, { signal: context?.signal }),
        );
        return { assetId: id, ...timeline };
      }),
  };
}

export function createAssetFacesTools(http: HttpClient): McpToolDefinition[] {
  return [createDetectTool(http), createFacesTool(http), createTimelineTool(http)];
}
