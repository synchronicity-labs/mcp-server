import { z } from 'zod';

const positiveSeconds = z.number().finite().positive();
const contextSchema = z.object({
  script: z.string().trim().min(1).max(5000).optional(),
  audioDuration: positiveSeconds.optional(),
  videoDuration: positiveSeconds.optional(),
  syncMode: z.enum(['bounce', 'loop', 'cut_off', 'silence', 'remap']).optional(),
});

export const estimateDurationInputs = {
  script: contextSchema.shape.script.describe(
    'Replacement speech text. Estimates spoken duration without synthesizing audio. Use for script-driven lipsync instead of pricing the full source video. An approximate quote; final speech length may differ.',
  ),
  audioDuration: contextSchema.shape.audioDuration.describe(
    'Measured replacement audio duration in seconds. Prefer this over a script estimate once speech audio exists.',
  ),
  videoDuration: contextSchema.shape.videoDuration.describe(
    'Source video duration in seconds, used with syncMode to account for cut_off or silence. Omit for an image.',
  ),
  syncMode: contextSchema.shape.syncMode.describe(
    'The same sync_mode selected for generation. cut_off uses the shorter input; silence uses the longer input; other modes follow replacement audio duration.',
  ),
};

// Match Sync's @sync/common/tts estimateAudioDuration. This standalone service
// cannot import the API monorepo's workspace packages.
function scriptDuration(script: string): number {
  let words = 0;
  for (const segment of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(script)) {
    if (!segment.isWordLike) continue;
    const cjkCharacters =
      segment.segment.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ??
      0;
    words += Math.max(1, cjkCharacters);
  }
  const characters = script.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  const wordDuration = words <= 1 ? words : Math.max(1, (words / 160) * 60);
  return Number(Math.max(wordDuration, characters / 16).toFixed(2));
}

export function resolveEstimateDuration(args: Record<string, unknown>) {
  const { script, audioDuration, videoDuration, syncMode } = contextSchema.parse(args);
  const {
    script: _script,
    audioDuration: _audio,
    videoDuration: _video,
    syncMode: _mode,
    ...body
  } = args;
  if (script === undefined && audioDuration === undefined) {
    if (videoDuration !== undefined || syncMode !== undefined)
      throw new Error('Supply script or audioDuration when using videoDuration or syncMode.');
    return { args: body, durationEstimate: undefined };
  }
  if (args.workflow === 'translate-and-dub')
    throw new Error('Translation estimates use source duration, not replacement script or audio.');
  if ((syncMode === 'cut_off' || syncMode === 'silence') && videoDuration === undefined)
    throw new Error('Supply videoDuration to estimate cut_off or silence accurately.');

  const driverDuration = positiveSeconds.parse(audioDuration ?? scriptDuration(script ?? ''));
  const duration =
    videoDuration === undefined
      ? driverDuration
      : syncMode === 'cut_off'
        ? Math.min(driverDuration, videoDuration)
        : syncMode === 'silence'
          ? Math.max(driverDuration, videoDuration)
          : driverDuration;
  return {
    args: { ...body, duration },
    durationEstimate: {
      durationSeconds: duration,
      audioDurationSeconds: driverDuration,
      source: audioDuration === undefined ? 'script' : 'audio',
      approximate: audioDuration === undefined,
      excludesSpeechSynthesis: true,
    },
  };
}
