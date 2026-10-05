import { z } from 'zod';

// Public model controls accepted by the generation API. Do not expose service-only options.
export const modelOptionsSchema = z
  .object({
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
    reasoning_enabled: z.boolean().optional(),
    model_mode: z.enum(['lips', 'face', 'head']).optional(),
  })
  .strict();
