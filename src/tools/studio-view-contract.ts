import { z } from 'zod';

const workflow = z
  .enum(['lipsync', 'image_to_video', 'translate_and_dub', 'edit_dialogue'])
  .describe('Studio workflow to show the project in.');
const projectId = z.uuid().describe('Project id from projects_list or projects_create.');
const generationId = z.uuid().describe('Id of an existing generation in that project.');
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
    projectId,
    workflow: workflow.optional(),
  }),
  z.strictObject({ type: z.literal('refresh-project'), projectId }),
  z.strictObject({ type: z.literal('refresh-assets'), projectId }),
  z.strictObject({ type: z.literal('open-generation'), projectId, generationId }),
  z.strictObject({
    type: z.literal('continue-generation'),
    projectId,
    generationId,
    workflow,
    seedSource: z
      .enum(['source-input', 'output'])
      .describe("Start the new draft from the generation's source inputs or from its output."),
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
  id: z.uuid().describe('A new UUID for this action. Reuse it only to retry an uncertain handoff.'),
  expectedRevision: z
    .number()
    .int()
    .positive()
    .describe('The view revision from studio-views_get.'),
  command: StudioViewCommandSchema,
});
export const AcknowledgeStudioViewSchema = z.strictObject({
  mountId: z.uuid(),
  id: z.uuid(),
  status: z.enum(['applied', 'blocked', 'failed']),
  reason: z.enum(['busy', 'stale', 'expired', 'unavailable']).optional(),
  context: StudioViewContextSchema.optional(),
});
