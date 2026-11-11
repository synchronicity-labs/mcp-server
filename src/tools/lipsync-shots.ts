import { z } from 'zod';
import { parseModelOptions } from './model-options.js';

/**
 * `shots` on lipsync_create and lipsync_create-timeline: the video's camera shots, sent as
 * options.shots to replace the pipeline's own shot detection, which misses jump cuts. Same
 * shape as faces_get-timeline shots, so an agent passes those as is. Shots always count
 * frames from the video's first frame, also next to timeline clips (segments). Listed only
 * to accounts with lipsync_planning (PARAMETER_FEATURES in account-features.ts); the API
 * refuses it for others.
 */
function shotsInput(endFrame: string, description: string) {
  return z
    .array(
      z
        .object({
          startFrame: z
            .number()
            .int()
            .nonnegative()
            .describe('First frame of the shot, counted from 0 at the video’s first frame.'),
          endFrame: z.number().int().positive().describe(endFrame),
        })
        .strict(),
    )
    .min(1)
    .max(2000)
    .optional()
    .describe(description);
}

const SOURCE =
  'The video’s camera shots, replacing Sync’s own shot detection, which misses jump cuts (same camera, footage removed). Start from faces_get-timeline shots and add a boundary at each cut it missed.';
const REAL_CUTS =
  'Every boundary must be a real cut: a boundary in mid-shot makes the mouth jump, and a shot that starts a few frames before a real cut gets the wrong face on those frames.';
const ORDER =
  'In video order: the first starts at frame 0 and each starts at the previous endFrame.';
const MODELS = 'sync-3, sync-3-pro or studio-1';

export const lipsyncShotsInput = shotsInput(
  'Frame after the shot’s last one (exclusive): the next shot’s startFrame.',
  `${SOURCE} ${REAL_CUTS} ${ORDER} ${MODELS} with a video only. Omit to let Sync detect shots.`,
);

export const timelineShotsInput = shotsInput(
  'Frame after the shot’s last one (EXCLUSIVE, unlike a clip’s inclusive endFrame): the next shot’s startFrame.',
  `${SOURCE} ${REAL_CUTS} Shots cover the whole video, not the clips: their frames always count from 0 at the video’s first frame, also when clips use seconds. ${ORDER} A shot’s endFrame is EXCLUSIVE (the frame after its last one), while a clip’s endFrame is INCLUSIVE (its last frame): a clip that ends where a shot ends has endFrame = that shot’s endFrame - 1. With shots, one clip can cover a speaker’s whole turn across several cuts, so the clips have fewer ends. ${MODELS} only. Omit to let Sync detect shots.`,
);

type Shot = { startFrame: number; endFrame: number };

function assertContiguous(shots: Shot[]): void {
  shots.forEach((shot, index) => {
    const start = index === 0 ? 0 : shots[index - 1]!.endFrame;
    if (shot.startFrame !== start)
      throw new Error(
        `shots[${index}].startFrame must be ${start}: the first shot starts at frame 0 and each starts at the previous endFrame.`,
      );
    if (shot.endFrame <= shot.startFrame)
      throw new Error(`shots[${index}].endFrame must be after its startFrame (exclusive end).`);
  });
}

/** A lipsync's options, with `shots` checked and added as options.shots. */
export function parseLipsyncOptions(
  args: Record<string, unknown>,
  request: { model: string; image?: boolean },
) {
  const options = parseModelOptions(args.options, request);
  const shots = lipsyncShotsInput.parse(args.shots);
  if (!shots) return options;
  if (request.image) throw new Error('shots needs a video input; an image has no shots.');
  assertContiguous(shots);
  return {
    ...options,
    shots: shots.map((shot) => ({ start_frame: shot.startFrame, end_frame: shot.endFrame })),
  };
}
