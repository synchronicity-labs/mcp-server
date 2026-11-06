import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';
import { modelOptionsSchema } from './model-options.js';

// Narrow projection of Studio's InternalGenerationSchema. Provider state and
// arbitrary generation metadata never cross the embedded-app boundary.
const mediaUrl = z.url({ protocol: /^https?$/ });
const face = modelOptionsSchema.shape.active_speaker_detection
  .unwrap()
  .options[1].strip()
  .extend({
    frame_number: z.number().finite().optional(),
    bounding_boxes: z.array(z.array(z.number().finite()).nullable()).optional(),
    bounding_boxes_url: mediaUrl.optional(),
  });
const options = modelOptionsSchema.strip().extend({
  active_speaker_detection: z.union([z.boolean(), face]).optional(),
  model_mode: z.string().optional(),
});
const audioRange = z.object({
  refId: z.string(),
  startTime: z.number().finite().optional(),
  endTime: z.number().finite().optional(),
});
const generation = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED']),
  workflow: z
    .enum([
      'lipsync',
      'translate_and_dub',
      'image_to_video',
      'edit_dialogue',
      'change_appearance',
      'timeline',
      'assistant',
    ])
    .nullish(),
  modelName: z.string().min(1),
  options,
  inputs: z.array(
    z.object({
      type: z.enum(['video', 'image', 'audio', 'text']),
      assetId: z.uuid().optional(),
      url: mediaUrl.optional(),
      refId: z.string().optional(),
      generatedBy: z.literal('tts').optional(),
      provider: z
        .object({
          name: z.string(),
          script: z.string(),
          voiceId: z.string(),
          stability: z.number().min(0).max(1).optional(),
          similarityBoost: z.number().min(0).max(1).optional(),
        })
        .optional(),
      trim_secs: z.array(z.number().finite()).optional(),
      segments_secs: z.array(z.array(z.number().finite())).optional(),
      segments_frames: z.array(z.array(z.number().finite())).optional(),
    }),
  ),
  segments: z
    .array(
      z.object({
        startTime: z.number().finite().optional(),
        endTime: z.number().finite().optional(),
        startFrame: z.number().finite().optional(),
        endFrame: z.number().finite().optional(),
        audioInput: audioRange.optional(),
        optionsOverride: options.optional(),
      }),
    )
    .nullish(),
  speakers: z
    .array(
      z.object({
        id: z.string(),
        audio: audioRange,
        face: face.omit({ auto_detect: true }),
      }),
    )
    .nullish(),
  outputMediaUrl: mediaUrl.nullish(),
  parentGenerationId: z.uuid().nullish(),
  dialogueEditJobId: z.uuid().nullish(),
  renderedFromAssetId: z.uuid().nullish(),
});

export function createGenerationContinuationTool(http: HttpClient): McpToolDefinition {
  const input = z
    .object({
      projectId: z.uuid().describe("The generation's own project id."),
      id: z.uuid().describe('Id of the existing generation to continue from.'),
    })
    .strict();
  return {
    name: 'generations_get-continuation',
    title: 'Read generation continuation inputs',
    description:
      "Read one existing generation with the inputs it was made from (workflow, modelName, options, inputs with asset ids or urls, segments, speakers, parentGenerationId and outputMediaUrl), so a follow-up generation can reuse them, such as redoing it with other audio or dubbing its output. Use it only when the user explicitly continues an existing generation; not for polling status or getting the result url (generations_get). projectId must be the generation's own project, such as projectId from generations_get; id comes from generations_list, projects_list-generations (when available) or a create response. Then pass continuation { workflow, parentGenerationId: id } with the same projectId to lipsync_create (workflow lipsync, image_to_video or translate_and_dub), dubbing_create (translate_and_dub) or dialogue-videos_create (edit_dialogue); other workflows cannot be continued. Returns the generation whatever its status, after checking access to the project and to every asset it references; it fails if the generation is not in that project or a referenced asset is no longer accessible.",
    inputSchema: input.shape,
    outputSchema: { submissionContextVersion: z.literal(1), generation },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (args, context) => {
      const { projectId, id } = input.parse(args);
      const signal = context?.signal;
      const project = z
        .object({ id: z.uuid() })
        .parse(await http.request('get', `/v2/projects/${projectId}`, { signal }));
      if (project.id !== projectId) throw new Error('Could not verify project access.');
      const page = z.object({ items: generation.array().length(1) }).parse(
        await http.request('get', '/v2/generations/list', {
          query: { projectId, ids: id, limit: '1' },
          signal,
        }),
      );
      const selected = page.items[0]!;
      if (selected.id !== id || selected.projectId !== projectId)
        throw new Error('The generation does not belong to this project.');
      for (const assetId of new Set([
        ...selected.inputs.flatMap((item) => (item.assetId ? [item.assetId] : [])),
        ...(selected.renderedFromAssetId ? [selected.renderedFromAssetId] : []),
      ])) {
        signal?.throwIfAborted();
        const asset = z
          .object({ id: z.uuid() })
          .parse(await http.request('get', `/v2/assets/${assetId}`, { signal }));
        if (asset.id !== assetId) throw new Error('Could not verify source asset access.');
      }
      return { submissionContextVersion: 1, generation: selected };
    },
  };
}
