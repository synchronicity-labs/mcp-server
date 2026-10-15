import { z } from 'zod';

// The API's generated OpenAPI schema omits the discriminated edit fields.
export const dialogueEditsSchema = z
  .array(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('change'),
        wordId: z.string(),
        replacement: z.string().min(1).max(500),
        pronunciation: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .refine((value) => /^(?=.*\p{L})[\p{L}\p{M} '’.-]+$/u.test(value), {
            message:
              'Use a plain-text pronunciation with letters, spaces, apostrophes, hyphens or periods.',
          })
          .optional()
          .describe('Optional plain-text respelling spoken instead of replacement.'),
      }),
      z.object({
        kind: z.literal('remove'),
        wordIds: z.array(z.string()).min(1),
        pronunciation: z.never().optional(),
      }),
    ]),
  )
  .min(1)
  .max(100)
  .describe(
    'Timed word edits. Change: {"kind":"change","wordId":"w1","replacement":"Hello"}. Remove a contiguous run: {"kind":"remove","wordIds":["w1"]}. Use word IDs from the completed transcription.',
  );
