import { z } from 'zod';

const workflow = z.enum(['lipsync', 'image_to_video', 'translate_and_dub', 'edit_dialogue']);
export const StudioViewContextSchema = z.strictObject({
  projectId: z.uuid().nullable(),
  draftId: z.uuid().nullable(),
  draftRevision: z.number().int().nonnegative().nullable(),
  editToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  busy: z.boolean(),
});
export const StudioViewCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('open-project'),
    projectId: z.uuid(),
    workflow: workflow.optional(),
  }),
  z.strictObject({ type: z.literal('refresh-project'), projectId: z.uuid() }),
  z.strictObject({ type: z.literal('refresh-assets'), projectId: z.uuid() }),
  z.strictObject({
    type: z.literal('open-generation'),
    projectId: z.uuid(),
    generationId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal('continue-generation'),
    projectId: z.uuid(),
    generationId: z.uuid(),
    workflow,
    seedSource: z.enum(['source-input', 'output']),
  }),
]);
export const StudioViewSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  context: StudioViewContextSchema,
  updatedAt: z.number(),
  action: z
    .object({
      id: z.uuid(),
      requestRevision: z.number().int().positive(),
      expectedContext: StudioViewContextSchema,
      command: StudioViewCommandSchema,
      expiresAt: z.number(),
      status: z.enum(['pending', 'applied', 'blocked', 'failed']),
      reason: z.enum(['busy', 'stale', 'expired', 'unavailable']).optional(),
    })
    .nullable(),
});
export const RegisterStudioViewSchema = z.strictObject({
  mountId: z.uuid(),
  claim: z.boolean().default(false),
  context: StudioViewContextSchema,
});
export const RequestStudioViewActionSchema = z.strictObject({
  id: z.uuid(),
  expectedRevision: z.number().int().positive(),
  command: StudioViewCommandSchema,
});
export const AcknowledgeStudioViewSchema = z.strictObject({
  mountId: z.uuid(),
  id: z.uuid(),
  status: z.enum(['applied', 'blocked', 'failed']),
  reason: z.enum(['busy', 'stale', 'expired', 'unavailable']).optional(),
  context: StudioViewContextSchema.optional(),
});
