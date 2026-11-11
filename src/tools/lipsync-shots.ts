import { z } from 'zod';
import { parseModelOptions } from './model-options.js';

/**
 * lipsync_create `shots`: the video's camera shots, sent as options.shots to replace the
 * pipeline's own shot detection, which misses jump cuts. Same shape as faces_get-timeline
 * shots, so an agent passes those as is. Listed only to accounts with lipsync_planning
 * (PARAMETER_FEATURES in account-features.ts); the API refuses it for others.
 */
export const lipsyncShotsInput = z
  .array(
    z
      .object({
        startFrame: z
          .number()
          .int()
          .nonnegative()
          .describe('First frame of the shot, counted from 0 at the video’s first frame.'),
        endFrame: z
          .number()
          .int()
          .positive()
          .describe('Frame after the shot’s last one (exclusive): the next shot’s startFrame.'),
      })
      .strict(),
  )
  .min(1)
  .max(2000)
  .optional()
  .describe(
    'The video’s camera shots, replacing Sync’s own shot detection, which misses jump cuts (same camera, footage removed). Start from faces_get-timeline shots and add a boundary at each cut it missed. Every boundary must be a real cut: a boundary in mid-shot makes the mouth jump, and a shot that starts a few frames before a real cut gets the wrong face on those frames. In video order: the first starts at frame 0 and each starts at the previous endFrame. sync-3, sync-3-pro or studio-1 with a video only. Omit to let Sync detect shots.',
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

/** lipsync_create's options, with `shots` checked and added as options.shots. */
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
