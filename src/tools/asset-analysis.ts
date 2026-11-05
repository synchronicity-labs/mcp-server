import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';
import { pollUntil, waitInput } from './job-wait.js';

/**
 * Scene detection and stem separation. Their API routes are internal and behind
 * server-side feature flags, so they are not in the public spec and are written by hand.
 * They are listed only to accounts whose features include them (account-features.ts);
 * a call from any other account still gets the API's 404, reported as not enabled.
 */

const assetId = z.uuid();

// A disabled flag answers Nest's bare 404 ({ statusCode, message: 'Not Found' }, no
// errorCode), and an API without the route answers "Cannot GET …". Coded 404s, such
// as asset_not_found, keep their own error.
const MISSING_ROUTE = / - (?:Not Found|Cannot (?:GET|POST) \S+)$/;

async function whenEnabled<T>(feature: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      error.status === 404 &&
      error.code === undefined &&
      MISSING_ROUTE.test(error.message)
    )
      throw new ApiRequestError(
        `${feature} isn't enabled for this account yet.`,
        404,
        'feature_not_enabled',
      );
    throw error;
  }
}

const sceneSchema = z.object({
  startFrame: z
    .number()
    .int()
    .nonnegative()
    .describe('First frame of the shot, counted from 0, inclusive.'),
  endFrame: z
    .number()
    .int()
    .nonnegative()
    .describe('Last frame of the shot, inclusive. The next scene starts at endFrame + 1.'),
  startSeconds: z
    .number()
    .nullable()
    .describe('Shot start in seconds from the start of the video (startFrame / fps).'),
  endSeconds: z
    .number()
    .nullable()
    .describe(
      'Shot end in seconds, (endFrame + 1) / fps: the next scene startSeconds. Null when fps is unknown.',
    ),
});
const scenesSchema = z.object({
  status: z
    .enum(['not_requested', 'pending', 'completed', 'failed'])
    .describe(
      'completed: scenes holds the shots. pending: detection is running. failed: the last run stored no scenes; call again to retry.',
    ),
  fps: z.number().positive().nullable().describe('Frame rate used for seconds; null if unknown.'),
  scenes: z.array(sceneSchema).describe('Shots in video order. Empty unless completed.'),
});
const scenesOutput = {
  assetId: assetId.describe('The VIDEO asset.'),
  ...scenesSchema.shape,
  jobId: z.string().optional().describe('Detection job started by this call, if it started one.'),
};
const sceneStart = z.object({
  success: z.boolean(),
  jobId: z.string().optional(),
  reason: z.string().optional(),
});

function createScenesTool(http: HttpClient): McpToolDefinition {
  const input = z.object({ assetId, wait: waitInput });
  return {
    name: 'scenes_detect',
    title: 'Detect scenes in a video',
    description:
      'Find the shots in a saved VIDEO asset. A scene is one continuous shot between two camera cuts. Returns scenes in video order, each with startFrame and endFrame (frames from 0, both inclusive; the next scene starts at endFrame + 1) and startSeconds and endSeconds (seconds from the start of the video; endSeconds equals the next scene startSeconds). ' +
      'Starts detection only when the asset has no stored scenes or the last run failed; otherwise it returns the stored or running result, so calling again never reruns a finished detection. Pass wait: true to wait on the server; while status is pending, call again with wait: true. ' +
      'Typical use: shot-aware lipsync with lipsync_create-timeline. Give each speaker one clip per shot and start and end clips on scene boundaries, so the lipsynced face never switches mid-shot; clip startFrame and endFrame are inclusive too, so a scene maps onto a clip as is.',
    inputSchema: input.shape,
    outputSchema: scenesOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: (args, context) =>
      whenEnabled('Scene detection', async () => {
        const { assetId: id, wait } = input.parse(args);
        const read = async (signal = context?.signal) =>
          scenesSchema.parse(
            await http.request('get', '/v2/asset-metadata/scenes', {
              query: { assetId: id },
              signal,
            }),
          );
        let state = await read();
        let jobId: string | undefined;
        // A new request clears stored scenes, so only start when there are none to keep.
        if (state.status === 'not_requested' || state.status === 'failed') {
          const started = sceneStart.parse(
            await http.request('post', '/v2/asset-metadata/scene-detection', {
              body: { assetId: id },
              signal: context?.signal,
            }),
          );
          if (!started.success)
            throw new Error(
              started.reason === 'unsupported_asset_type'
                ? `Asset ${id} is not a video. Scene detection needs a VIDEO asset.`
                : `Scene detection did not start for asset ${id}${started.reason ? `: ${started.reason}` : ''}.`,
            );
          jobId = started.jobId;
          state = { ...state, status: 'pending', scenes: [] };
        }
        if (wait && state.status === 'pending')
          state = await pollUntil(read, (scenes) => scenes.status !== 'pending', context, {
            describe: (scenes) => `scene detection ${scenes.status}`,
          });
        return { assetId: id, ...state, ...(jobId ? { jobId } : {}) };
      }),
  };
}

const stemJobSchema = z.object({
  id: z.uuid().describe('Stem separation job ID.'),
  assetId: assetId.describe('The AUDIO or VIDEO asset whose audio is separated.'),
  status: z
    .enum(['pending', 'processing', 'completed', 'failed'])
    .describe(
      'pending: queued. processing: extracting and separating. completed: both stem assets exist. failed: see error; call again to retry.',
    ),
  vocalsAssetId: z
    .uuid()
    .nullable()
    .describe('AUDIO asset with only the voices (speech and singing). Null until completed.'),
  backgroundAssetId: z
    .uuid()
    .nullable()
    .describe(
      'AUDIO asset with everything but the voices: music, ambience and effects in one track. Null until completed.',
    ),
  vocalsUrl: z.string().nullable().describe('URL of the vocals WAV. Null until completed.'),
  backgroundUrl: z.string().nullable().describe('URL of the background WAV. Null until completed.'),
  error: z
    .object({ code: z.string(), message: z.string() })
    .nullable()
    .describe('Why the job failed, such as stem_separation_duration_exceeded. Null otherwise.'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function createStemsTool(http: HttpClient): McpToolDefinition {
  const input = z.object({ assetId, wait: waitInput });
  return {
    name: 'stems_separate',
    title: 'Separate vocals from background audio',
    description:
      'Split the audio of a saved AUDIO or VIDEO asset into two new AUDIO assets: vocals, the voices alone (speech and singing), and background, everything else (music, ambience and effects) in one track. A video has its audio extracted first. Both stems are mono 44.1 kHz WAV with the same length and timing as the source, in seconds, and add back up to it. ' +
      'Typical use: keep the source soundtrack under a dub. Sync tools do not mix audio, so mix the dubbed voice over backgroundUrl yourself (for example with ffmpeg amix), upload the mix and use it as the lipsync audio. The vocals stem is a clean voice track, for example a voice clone sample. ' +
      'The source must be in Sync storage; for stem_separation_source_not_hosted, upload the file and separate the new asset. Starts a job only when this asset has none or the last one failed; a running or completed separation is returned as is, so calling again never runs it twice. A job can take several minutes (at most 20). Pass wait: true to wait on the server; while status is pending or processing, call again with wait: true.',
    inputSchema: input.shape,
    outputSchema: stemJobSchema.shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: (args, context) =>
      whenEnabled('Stem separation', async () => {
        const { assetId: id, wait } = input.parse(args);
        const path = `/v2/assets/${id}/separate-stems`;
        const request = async (method: 'get' | 'post', signal = context?.signal) =>
          stemJobSchema.parse(await http.request(method, path, { signal }));
        // Read first: the start route is limited to 60 calls an hour, and polling uses this one.
        let job = await request('get').catch((error: unknown) => {
          if (error instanceof ApiRequestError && error.code === 'stem_separation_not_found')
            return undefined;
          throw error;
        });
        if (!job || job.status === 'failed') job = await request('post');
        if (wait && !settled(job))
          job = await pollUntil((signal) => request('get', signal), settled, context, {
            describe: (stems) => `stem separation ${stems.status}`,
          });
        return job;
      }),
  };
}

const settled = (job: { status: string }) => job.status === 'completed' || job.status === 'failed';

export function createAssetAnalysisTools(http: HttpClient): McpToolDefinition[] {
  return [createScenesTool(http), createStemsTool(http)];
}
