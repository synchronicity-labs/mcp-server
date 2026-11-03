import { z } from 'zod';

// Public model controls accepted by the generation API. Do not expose service-only options.
export const modelOptionsSchema = z
  .object({
    sync_mode: z.enum(['bounce', 'loop', 'cut_off', 'silence', 'remap']).optional(),
    temperature: z.number().min(0).max(1).nullable().optional(),
    active_speaker_detection: z
      .union([
        z.boolean(),
        z
          .object({
            auto_detect: z.boolean().optional(),
            use_v2: z.boolean().optional(),
            v3: z.boolean().optional(),
            face_image: z.string().optional(),
            frame_number: z.number().int().nonnegative().optional(),
            coordinates: z.tuple([z.number(), z.number()]).optional(),
          })
          .strict(),
      ])
      .optional(),
    occlusion_detection_enabled: z.boolean().optional(),
    reasoning_enabled: z
      .boolean()
      .optional()
      .describe('Only lipsync-2-pro supports reasoning; it is ignored for other models.'),
    model_mode: z.enum(['lips', 'face', 'head']).optional(),
  })
  .strict();

const REASONING_MODELS = new Set(['lipsync-2-pro', 'sync-2-pro']);

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
