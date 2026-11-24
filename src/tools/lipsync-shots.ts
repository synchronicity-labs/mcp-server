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

/**
 * Shots that agent feedback reports as COMPLETED with lips that barely moved (CRAFT-8549).
 * Shared by lipsync_create, in every profile's wording, and lipsync_create-timeline.
 */
export const HARD_SHOT_CHECK =
  'Hard shots can finish COMPLETED with lips that barely move: a face turned toward profile, a small face the model has to enlarge, several faces or a crowd, a microphone or hand over the mouth, a face hidden for part of the shot, or singing over music. ' +
  'Before paying for a video like that, when the faces tools are available run faces_detect, then faces_get-people or faces_get-timeline, and pick the face yourself with options.active_speaker_detection { frame_number, coordinates: [x, y] } (on lipsync_create-timeline, a clip speaker). ' +
  'A still image has no face choice: the faces tools read videos only and an image ignores active_speaker_detection, so for a small face or a group photo suggest a tighter crop of the one face instead. ' +
  'For a song, drive the lipsync with the vocals stem from stems_separate when available; the output then plays only that stem, so say so. ' +
  'Tell the person, before spending, that the shot is hard and why, what you will do about it, and that the lips may still barely move.';
