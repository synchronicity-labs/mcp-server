import { z } from 'zod';
import {
  generationCardProgressSchema,
  generationDisplaySchema,
} from './generation-card-details.js';

const resultUrl = z
  .string()
  .nullable()
  .describe(
    'Signed result URL when the generation is complete, named as in the API (GET /v2/generations/{id}). Copy this exact string verbatim; do not reconstruct, shorten, or edit it.',
  )
  .optional();

export const generationOutputSchema = {
  display: generationDisplaySchema
    .optional()
    .describe(
      'Authorized job title, source thumbnail and dubbing languages for the generation card; missing details are unknown.',
    ),
  progress: generationCardProgressSchema
    .optional()
    .describe(
      'Measured worker progress when include=progress is requested; task counts are internal tasks, not shots.',
    ),
  id: z.string().describe('Sync generation id.').optional(),
  projectId: z.string().nullable().describe('Sync project containing this generation.').optional(),
  status: z.string().describe('Current generation status.').optional(),
  model: z.string().describe('Model used for the generation.').optional(),
  outputMediaUrl: resultUrl,
  outputUrl: z
    .string()
    .nullable()
    .describe('Deprecated alias of outputMediaUrl, with the same value. Read outputMediaUrl.')
    .meta({ deprecated: true })
    .optional(),
  generationEstimate: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe(
      'Server-provided completion estimate and server clock. Use only for approximate remaining time; do not invent an estimate when absent.',
    ),
  outputDuration: z.number().nullable().describe('Output duration in seconds.').optional(),
  error: z.unknown().optional(),
  errorCode: z.unknown().optional(),
};

/**
 * GET /v2/generations/{id} answers with the API's GenerationDto, whose names differ from
 * the Generation that /v2/generate returns. Keep the shared names, add the DTO's own.
 */
export const generationDtoOutputSchema = {
  ...generationOutputSchema,
  model: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .describe('Model used for the generation.')
    .optional(),
  modelName: z.string().describe('Name of the model used for the generation.').optional(),
  outputMediaLength: z.number().nullable().describe('Output duration in seconds.').optional(),
  outputDuration: z
    .number()
    .nullable()
    .describe('Deprecated alias of outputMediaLength, with the same value.')
    .meta({ deprecated: true })
    .optional(),
  potentialError: z.unknown().optional(),
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
