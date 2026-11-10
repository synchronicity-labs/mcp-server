import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import { schemaProperty as property } from '../openapi/parser.js';
import type { ParsedOperation } from '../openapi/types.js';
import { generationContextHeaders, generationContextSchema } from './generation-context.js';
import type { McpToolDefinition } from './generator.js';
import { modelOptionsSchema } from './model-options.js';
import { generationOutputSchema } from './output-schemas.js';
import {
  assertProjectDestination,
  createProjectId,
  newProjectFields,
} from './project-destination.js';
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
      continuation: generationContextSchema
        .describe(
          'Only when the user explicitly continues an existing generation in this project: the parent generation (from generations_get-continuation) and its workflow, which must be translate_and_dub. Requires projectId.',
        )
        .optional(),
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
        .describe(
          'Name for the NEW project created when projectId is omitted; defaults to "Translate and Dub". Cannot be combined with projectId. A matching existing name is never reused.',
        ),
      projectId: z
        .uuid()
        .optional()
        .describe(
          'Project ID only when explicitly selected by the user, or just created for this request; requires projectIntent=explicit. Cannot be combined with projectName or projectCreationKey. Otherwise omit it to create a new project. Keep unchanged on retries.',
        ),
      targetLang: z
        .enum(target.data)
        .describe(
          'Language code to dub into, for example es or pt-BR; the same list dubbing_get-options returns as targetLanguages.',
        ),
      sourceLang: z
        .enum(source.data)
        .default('auto')
        .describe(
          'Spoken language of the source video, from dubbing_get-options sourceLanguages. Defaults to auto, which detects it; set a code only when the user names the source language.',
        ),
      model: z
        .string()
        .trim()
        .min(1)
        .describe(
          'Lipsync model name from models_list (for example sync-3), used for the final render. Any generations_estimate-cost quote for this dub must use the same model.',
        ),
      options: modelOptionsSchema.optional(),
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9._~-]{1,128}$/)
        .describe(
          'Persist one unique key per approved generation before calling. Retry an uncertain request with this exact key, the same projectCreationKey and unchanged inputs; never automatically create a new key.',
        ),
    })
    .strict();

  return [
    {
      name: 'dubbing_create',
      title: 'Translate and dub a video',
      description:
        "Translate a saved video's speech into another language and lipsync it to the dubbed audio, as one paid sync. generation that covers both dubbing and the final render. Use it for a finished dubbed video. Not for subtitles only or translating a text document; to lipsync audio you already have, use lipsync_create. To review translated audio first, translation-previews_create (offered only when dubbing_get-options reports previewAvailable) translates a saved AUDIO asset, not a video.\n\nFor social video URLs, import through assets_create and wait for the saved asset before estimating or calling this tool. This is a paid action: confirm the requested language, configuration and estimated cost with the user before calling. Use generations_estimate-cost with workflow=translate-and-dub when that input is supported, and disclose any excluded external provider charges. Without the combined breakdown, lipsync pricing is not the full workflow cost. Omit projectId to start a NEW project (fresh projectCreationKey); pass projectId with projectIntent=explicit only for a project the user selected or one just created for this request, never because a name matches or an editor is open.\n\nReturns the generation (id, status, projectId); poll that id with generations_get, or jobs_wait (kind generation) when available, until COMPLETED, then read outputMediaUrl. After an uncertain response, retry only with the same idempotencyKey, projectCreationKey and inputs; never create another job to finish or recover it.",
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
        const signal = context?.signal;
        signal?.throwIfAborted();
        assertProjectDestination(input.projectId, input.projectName, input.projectCreationKey);
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
            signal,
          ));
        const project = input.projectId
          ? await httpClient.request('get', `/v2/projects/${projectId}`, {
              signal,
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
        signal?.throwIfAborted();
        const options = input.options;
        if (typeof options?.active_speaker_detection === 'boolean') {
          options.active_speaker_detection = { auto_detect: options.active_speaker_detection };
        }
        const lineage = await generationContextHeaders(
          httpClient,
          args,
          ['translate_and_dub'],
          signal,
        );
        return httpClient.request('post', '/v2/generate', {
          signal,
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
      name: 'dubbing_get-options',
      title: 'Translation options',
      description:
        "List the language codes sync. translation accepts (targetLanguages, and sourceLanguages, which also includes auto for detection) and whether the translated-audio preview tools are offered (previewAvailable). Use it to pick a valid targetLang or sourceLang for dubbing_create or translation-previews_create; translation-previews_create takes targetLang as free text, so check the code here first. Not for prices: use generations_estimate-cost or translation-previews_estimate. Takes no input and answers from the API's published schema, so it creates nothing and costs nothing. Codes look like es, pt-BR or zh-TW; the translation-previews tools exist only when previewAvailable is true.",
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
