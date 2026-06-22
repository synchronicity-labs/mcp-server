import { z } from 'zod';

export const generationOutputSchema = {
  id: z.string().describe('Sync generation id.').optional(),
  status: z.string().describe('Current generation status.').optional(),
  model: z.string().describe('Model used for the generation.').optional(),
  outputUrl: z
    .string()
    .nullable()
    .describe('Signed result URL when the generation is complete.')
    .optional(),
  outputDuration: z.number().nullable().describe('Output duration in seconds.').optional(),
  error: z.unknown().optional(),
  errorCode: z.unknown().optional(),
};

export const uploadMediaOutputSchema = {
  assetId: z.string().describe('Durable Sync asset id for the uploaded file.'),
  mediaType: z.enum(['video', 'image', 'audio']).describe('Uploaded media type.'),
  assetType: z.enum(['VIDEO', 'IMAGE', 'AUDIO']).describe('Sync asset type.'),
  input: z
    .object({
      type: z.enum(['video', 'image', 'audio']),
      assetId: z.string(),
    })
    .describe('Generation input object that can be passed to Sync generation tools.'),
};
