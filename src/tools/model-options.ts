import { z } from 'zod';

// Public model controls accepted by the generation API. Do not expose service-only options.
export const modelOptionsSchema = z
  .object({
    sync_mode: z
      .enum(['bounce', 'loop', 'cut_off', 'silence', 'remap'])
      .optional()
      .describe(
        'How to fit audio and video of different lengths: bounce (play the video forward, then in reverse), loop, cut_off (stop at the shorter input), silence (pad with silence to the longer input) or remap (change the video speed to match the audio).',
      ),
    temperature: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .optional()
      .describe('How expressive the mouth movement is, from 0 to 1. Omit for the model default.'),
    active_speaker_detection: z
      .union([
        z.boolean(),
        z
          .object({
            auto_detect: z.boolean().optional().describe('Find the person speaking automatically.'),
            use_v2: z.boolean().optional().describe('Use the second-generation speaker detector.'),
            v3: z.boolean().optional().describe('Use the third-generation speaker detector.'),
            face_image: z
              .string()
              .optional()
              .describe("URL of a reference image of the speaker's face."),
            frame_number: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe('Zero-based video frame that coordinates refer to.'),
            coordinates: z
              .tuple([z.number(), z.number()])
              .optional()
              .describe("[x, y] pixel position of the speaker's face on frame_number."),
          })
          .strict(),
      ])
      .optional()
      .describe(
        'Which face to lipsync when several people are visible: true or { auto_detect: true } to find the speaker, or frame_number plus coordinates to pick one. Omit for a single face or an image.',
      ),
    occlusion_detection_enabled: z
      .boolean()
      .optional()
      .describe(
        'Keep hands, microphones and other objects that pass in front of the mouth in front of it. Slower.',
      ),
    reasoning_enabled: z
      .boolean()
      .optional()
      .describe('Only lipsync-2-pro supports reasoning; it is ignored for other models.'),
    model_mode: z
      .enum(['lips', 'face', 'head'])
      .optional()
      .describe('How much of the face the model may change: lips, face or head.'),
  })
  .strict()
  .describe('Optional model controls. Omit any field to use its default.');

/** Models that charge more with reasoning on; every other model has none. */
export const REASONING_MODELS = new Set(['lipsync-2-pro', 'sync-2-pro']);

/**
 * The API takes speaker detection as an object; agents may send a boolean. Agents also
 * turn on reasoning for models without it, and speaker detection for a still image, and
 * the API rejects both, so drop them rather than fail the whole request.
 */
export function parseModelOptions(
  value: unknown,
  request: { model: string; image?: boolean },
): z.infer<typeof modelOptionsSchema> | undefined {
  const options = modelOptionsSchema.optional().parse(value);
  if (!options) return options;
  if (typeof options.active_speaker_detection === 'boolean') {
    options.active_speaker_detection = { auto_detect: options.active_speaker_detection };
  }
  if (!REASONING_MODELS.has(request.model)) delete options.reasoning_enabled;
  if (request.image) delete options.active_speaker_detection;
  return options;
}
