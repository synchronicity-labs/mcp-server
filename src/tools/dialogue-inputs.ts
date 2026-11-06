import { z } from 'zod';

// Edit Dialogue tool inputs, shared by the tools in dialogue.ts.
export const sourceSchema = z.object({
  projectId: z.uuid().describe('Project the Edit Dialogue work belongs to, from projects_create.'),
  videoAssetId: z
    .uuid()
    .describe(
      'Saved VIDEO asset being edited. Use the videoAssetId dialogue-transcriptions_create returned when it made a copy.',
    ),
});
export const transcriptionIdInput = z
  .uuid()
  .describe('Transcription id from dialogue-transcriptions_create.');
export const previewId = z.uuid().describe('Preview id from dialogue-previews_create.');
export const previewKeySchema = z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/);

// The API's edit items are a oneOf, which the OpenAPI conversion turns into untyped items,
// so agents had to guess their shape.
export const dialogueEdits = z
  .array(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('change'),
        wordId: z.string().describe('Timed word ID from the source transcript.'),
        replacement: z.string().min(1).max(500).describe('What the speaker says instead.'),
        pronunciation: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe(
            'Plain-text respelling for a name or word the voice would otherwise mispronounce.',
          ),
      }),
      z.object({
        kind: z.literal('remove'),
        wordIds: z.array(z.string()).min(1).describe('Timed word IDs to remove.'),
      }),
    ]),
  )
  .min(1)
  .max(100)
  .describe('User-approved changes/removals referencing timed word IDs in the source transcript.');
