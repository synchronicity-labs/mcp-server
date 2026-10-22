import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';
import { modelOptionsSchema } from './model-options.js';

const speech = z.strictObject({
  text: z.string().max(5000),
  voiceId: z.string().min(1).max(200).nullable(),
  stability: z.number().min(0).max(1),
  similarityBoost: z.number().min(0).max(1),
});
// Stored drafts retain the public API's legacy model modes and speaker data.
// New chat edits still use the narrower visible-control schema below.
const storedOptions = modelOptionsSchema.extend({
  model_mode: z.string().optional(),
  active_speaker_detection: z
    .union([
      z.boolean(),
      z.object({
        auto_detect: z.boolean().optional(),
        use_v2: z.boolean().optional(),
        v3: z.boolean().optional(),
        frame_number: z.number().optional(),
        coordinates: z.tuple([z.number(), z.number()]).optional(),
        bounding_boxes: z.array(z.array(z.number()).nullable()).optional(),
        bounding_boxes_url: z.string().optional(),
        face_image: z.string().optional(),
      }),
    ])
    .optional(),
});
const state = z.strictObject({
  workflow: z.enum(['lipsync', 'image_to_video', 'translate_and_dub', 'edit_dialogue']),
  visualId: z.uuid().nullable(),
  audioId: z.uuid().nullable(),
  derivedAudioVisualId: z.uuid().nullable().default(null),
  audioRemoved: z.boolean().default(false),
  parentGenerationId: z.uuid().optional(),
  model: z.string().min(1).max(100),
  options: storedOptions,
  targetLang: z.string().max(20),
  sourceLang: z.string().max(20),
  speech,
});
const draft = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  revision: z.number().int().positive(),
  appliedRevision: z.number().int().nonnegative(),
  editable: z.boolean(),
  updatedAt: z.string(),
  state,
});
const identity = { projectId: z.uuid(), draftId: z.uuid() };
const edit = z.strictObject({
  ...identity,
  expectedRevision: z.number().int().positive(),
  patch: state
    .omit({ parentGenerationId: true, derivedAudioVisualId: true, audioRemoved: true })
    .partial()
    .extend({
      options: modelOptionsSchema.optional(),
      speech: speech.partial().optional(),
    })
    .strict()
    .refine((patch) => Object.keys(patch).length > 0, 'Supply a draft change.'),
});

const save = z.object({
  ...identity,
  expectedRevision: z.number().int().nonnegative(),
  state,
  editable: z.boolean(),
});
const acknowledge = z.object({ ...identity, revision: z.number().int().positive() });

export function supportsStudioDrafts(operations: ParsedOperation[]): boolean {
  return [
    ['StudioDraftsController_get', 'get'],
    ['StudioDraftsController_save', 'put'],
    ['StudioDraftsController_acknowledge', 'post'],
  ].every(([id, method]) =>
    operations.some(
      (op) => op.operationId === id && op.method === method && op.studioDraftVersion === 1,
    ),
  );
}

/** The API owns authorization, persistence and compare-and-set across MCP sessions/pods. */
export function createStudioDraftTools(
  operations: ParsedOperation[],
  http: HttpClient,
): McpToolDefinition[] {
  if (!supportsStudioDrafts(operations)) return [];
  const path = (args: { projectId: string; draftId: string }) =>
    `/v2/projects/${args.projectId}/studio-drafts/${args.draftId}`;
  async function read(args: { projectId: string; draftId: string }, signal?: AbortSignal) {
    const result = draft.parse(await http.request('get', path(args), { signal }));
    if (result.id !== args.draftId || result.projectId !== args.projectId)
      throw new Error('Sync returned a different Studio draft.');
    return result;
  }
  const writeAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
  const appOnly = { ui: { visibility: ['app'] } };
  return [
    {
      name: 'get-studio-draft',
      title: 'Read current Studio draft',
      description:
        'Read the draftId/projectId published by the open Studio. Use its current revision before changing selections or settings. appliedRevision equal to revision means Studio acknowledged the change; otherwise it is saved but awaiting Studio. Never infer a displayed selection from chat prose.',
      inputSchema: identity,
      outputSchema: draft.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: (args, context) => read(z.object(identity).parse(args), context?.signal),
    },
    {
      name: 'update-studio-draft',
      title: 'Change Studio selections and settings',
      description:
        'Update only the open editable Studio draft, using its published draftId/projectId and the expectedRevision returned by get-studio-draft. Supports media IDs, workflow, model options, language and unsent speech settings. This does not generate, translate, clone, upload, or spend credits. On a conflict, read the draft and reconcile; never automatically overwrite newer edits. A successful save is awaiting Studio until appliedRevision equals revision; only then claim the UI applied it.',
      inputSchema: edit.shape,
      outputSchema: draft.shape,
      annotations: writeAnnotations,
      handler: async (args, context) => {
        const input = edit.parse(args);
        const current = await read(input, context?.signal);
        if (current.revision !== input.expectedRevision)
          throw new ApiRequestError(
            'Studio has newer edits. Read the current draft before changing it.',
            409,
            'STUDIO_DRAFT_CONFLICT',
          );
        if (!current.editable)
          throw new ApiRequestError(
            'Studio is protecting an active request or recovery. Return to an editable draft first.',
            409,
            'STUDIO_DRAFT_BUSY',
          );
        const patch = input.patch;
        const next = {
          ...current.state,
          ...patch,
          options: { ...current.state.options, ...patch.options },
          speech: { ...current.state.speech, ...patch.speech },
        };
        if (patch.audioId !== undefined) {
          next.audioRemoved = patch.audioId === null;
          next.derivedAudioVisualId = null;
        } else if (
          patch.visualId !== undefined &&
          patch.visualId !== current.state.visualId &&
          current.state.derivedAudioVisualId
        ) {
          next.audioId = null;
          next.audioRemoved = true;
          next.derivedAudioVisualId = null;
        }
        return draft.parse(
          await http.request('put', path(input), {
            body: {
              expectedRevision: input.expectedRevision,
              state: state.parse(next),
              editable: true,
            },
            signal: context?.signal,
          }),
        );
      },
    },
    {
      name: 'save-studio-draft',
      title: 'Save Studio draft',
      description:
        'Studio-only compare-and-set of the editable snapshot and current recovery lock. No provider work is performed.',
      inputSchema: save.shape,
      outputSchema: draft.shape,
      meta: appOnly,
      annotations: writeAnnotations,
      handler: async (args, context) => {
        const input = save.parse(args);
        return draft.parse(
          await http.request('put', path(input), {
            body: {
              expectedRevision: input.expectedRevision,
              state: input.state,
              editable: input.editable,
            },
            signal: context?.signal,
          }),
        );
      },
    },
    {
      name: 'ack-studio-draft',
      title: 'Acknowledge applied Studio draft',
      description:
        'Studio-only acknowledgement after validating, applying and persisting the exact revision. Does not edit settings or start jobs.',
      inputSchema: acknowledge.shape,
      outputSchema: draft.shape,
      meta: appOnly,
      annotations: { ...writeAnnotations, idempotentHint: true },
      handler: async (args, context) => {
        const input = acknowledge.parse(args);
        return draft.parse(
          await http.request('post', `${path(input)}/acknowledgement`, {
            body: { revision: input.revision },
            signal: context?.signal,
          }),
        );
      },
    },
  ];
}
