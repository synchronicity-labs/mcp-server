import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import { schemaProperty as property } from '../openapi/parser.js';
import type { ParsedOperation } from '../openapi/types.js';
import { generationContextHeaders, generationContextSchema } from './generation-context.js';
import type { McpToolDefinition } from './generator.js';
import { modelOptionsSchema } from './model-options.js';
import { generationOutputSchema } from './output-schemas.js';
import { createProjectId, newProjectFields } from './project-destination.js';
import { translationPreviewAvailable } from './translation-preview.js';

export function translationOperation(operations: ParsedOperation[]): ParsedOperation | undefined {
  return operations.find(
    (operation) =>
      operation.operationId === 'GenerateController_createGeneration' &&
      operation.method === 'post' &&
      operation.path === '/v2/generate' &&
      operation.requestBody?.contentType === 'application/json',
  );
}

export function createTranslationTools(
  operations: ParsedOperation[],
  httpClient: HttpClient,
): McpToolDefinition[] {
  const dub = property(translationOperation(operations)?.requestBody?.schema, 'dubParams');
  const languageList = z.array(z.string().min(1)).nonempty();
  const target = languageList.safeParse(property(dub, 'targetLang')?.enum);
  const source = languageList.safeParse(property(dub, 'sourceLang')?.enum);
  // Older APIs must not advertise a workflow they cannot validate.
  if (!target.success || !source.success || !source.data.includes('auto')) return [];

  const schema = z
    .object({
      continuation: generationContextSchema.optional(),
      videoAssetId: z
        .uuid()
        .describe(
          'Existing Sync VIDEO asset in the connected organization. For a social link, first create a NEW project unless the user explicitly chose an existing one. Import via assets_create with type=VIDEO and that projectId, wait for its saved asset id, then pass the same projectId with projectIntent=explicit.',
        ),
      ...newProjectFields,
      projectName: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('Name for a NEW project. A matching existing name is never reused.'),
      projectId: z
        .uuid()
        .optional()
        .describe(
          'Project ID only when explicitly selected by the user, or just created for this request. Otherwise omit it to create a new project. Keep unchanged on retries.',
        ),
      targetLang: z.enum(target.data).describe('Target language from the API-supported list.'),
      sourceLang: z.enum(source.data).default('auto'),
      model: z.string().trim().min(1).describe('Video lip-sync model returned by models_get.'),
      options: modelOptionsSchema.optional(),
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9._~-]{1,128}$/)
        .describe(
          'Persist one unique key per approved generation. Retry an uncertain request with this exact key and unchanged inputs; never automatically create a new key.',
        ),
    })
    .strict();

  return [
    {
      name: 'create-translate-and-dub',
      title: 'Translate and dub a video',
      description:
        'Use this when the user wants to translate and dub a video into another language with matching lip movements. Not for subtitles only or translating a text document. Requires a saved video asset, model, and persistent idempotency key. By default creates a NEW project using a fresh projectCreationKey, even when projectName matches existing work. Preserve that UUID and key on retries. Supply projectId only for an explicit selection or the project just created for this request; never infer it from a workflow name or open editor. For social video URLs, import through assets_create and wait for the saved asset before estimating or calling this tool. ' +
        'This is a paid action: confirm the requested language, configuration and estimated cost with the user before calling. Use generate_estimate-cost with workflow=translate-and-dub when that input is supported, and disclose any excluded external provider charges. Without the combined breakdown, lip-sync pricing is not the full workflow cost. ' +
        'The API manages dubbing and final rendering under the returned generation id. Poll generate_get-generation for that same id until COMPLETED; do not create another job to finish or recover it.',
      inputSchema: schema.shape,
      outputSchema: generationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (args, context) => {
        const input = schema.parse(args);
        context?.signal?.throwIfAborted();
        if (input.projectId && (input.projectName || input.projectCreationKey))
          throw new Error('Provide projectId or a new project name/UUID, not both.');
        if (input.continuation && !input.projectId)
          throw new Error('A continuation requires its explicitly selected projectId.');
        const projectId =
          input.projectId ??
          (await createProjectId(
            httpClient,
            {
              name: input.projectName ?? 'Translate and Dub',
              projectCreationKey: input.projectCreationKey,
              idempotencyKey: input.idempotencyKey,
              defaultWorkflow: 'translate_and_dub',
            },
            context?.signal,
          ));
        const project = input.projectId
          ? await httpClient.request('get', `/v2/projects/${projectId}`, {
              signal: context?.signal,
            })
          : { id: projectId };
        if (
          !project ||
          typeof project !== 'object' ||
          !('id' in project) ||
          project.id !== projectId
        ) {
          throw new Error('Sync could not verify access to this project. Refresh and try again.');
        }
        context?.signal?.throwIfAborted();
        const options = input.options;
        if (typeof options?.active_speaker_detection === 'boolean') {
          options.active_speaker_detection = { auto_detect: options.active_speaker_detection };
        }
        const lineage = await generationContextHeaders(
          httpClient,
          args,
          ['translate_and_dub'],
          context?.signal,
        );
        return httpClient.request('post', '/v2/generate', {
          signal: context?.signal,
          headers: { ...lineage, 'Idempotency-Key': input.idempotencyKey },
          body: {
            model: input.model,
            projectId,
            input: [{ type: 'video', assetId: input.videoAssetId }],
            dubParams: { targetLang: input.targetLang, sourceLang: input.sourceLang },
            ...(options === undefined ? {} : { options }),
          },
        });
      },
    },
    {
      name: 'get-translation-options',
      title: 'Translation options',
      description:
        'Read the source and target languages supported by the current translation API. Does not create a generation or estimate pricing.',
      inputSchema: {},
      outputSchema: {
        targetLanguages: languageList,
        sourceLanguages: languageList,
        previewAvailable: z.boolean(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async () => ({
        targetLanguages: target.data,
        sourceLanguages: source.data,
        previewAvailable: translationPreviewAvailable(operations),
      }),
    },
  ];
}
