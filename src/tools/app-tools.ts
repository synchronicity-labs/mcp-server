import { z } from 'zod';
import { type ClientProfile, resolveClientProfile } from '../client-profile.js';
import type { HttpClient } from '../http-client.js';
import { type UploadRuntime, uploadRuntime } from '../upload-runtime.js';
import { generationContextHeaders, generationContextSchema } from './generation-context.js';
import type { McpToolDefinition } from './generator.js';
import {
  ASSET_TYPE_BY_KIND,
  assertValidFileParam,
  fileInput,
  type MediaKind,
  type MediaParam,
  resolveMedia,
  uploadMediaAsset,
} from './media-upload.js';
import { modelOptionsSchema } from './model-options.js';
import { generationOutputSchema, uploadMediaOutputSchema } from './output-schemas.js';

type ProjectSummary = { id: string; name: string | null };
type ProjectsPage = { items: ProjectSummary[]; nextCursor?: string };

function providedCount(...values: unknown[]): number {
  return values.filter(Boolean).length;
}

function assertSingleSource(kind: MediaKind, count: number): void {
  if (count > 1) {
    throw new Error(
      `Provide only one ${kind} source — use either ${kind}Url, ${kind}AssetId, or the uploaded ${kind} file param.`,
    );
  }
}

function normalizedProjectName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

async function findProjectIdByName(
  httpClient: HttpClient,
  projectName: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  do {
    signal?.throwIfAborted();
    const result = (await httpClient.request('get', '/v2/projects', {
      signal,
      query: {
        searchQuery: projectName,
        sortBy: 'name',
        limit: '100',
        ...(cursor ? { cursor } : {}),
      },
    })) as ProjectsPage;

    if (!Array.isArray(result?.items)) {
      throw new Error('Sync returned an invalid projects list.');
    }

    const normalizedName = normalizedProjectName(projectName);
    const existing = result.items.find(
      (project) =>
        typeof project.id === 'string' &&
        typeof project.name === 'string' &&
        normalizedProjectName(project.name) === normalizedName,
    );
    if (existing) return existing.id;

    cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
    if (cursor && seenCursors.has(cursor)) {
      throw new Error('Sync returned a repeated projects cursor.');
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  return undefined;
}

async function getOrCreateProjectId(
  httpClient: HttpClient,
  requestedProjectName: string | undefined,
  defaultName: string,
  signal?: AbortSignal,
): Promise<string> {
  const projectName = requestedProjectName?.trim() || defaultName;
  const existingProjectId = await findProjectIdByName(httpClient, projectName, signal);
  if (existingProjectId) return existingProjectId;

  signal?.throwIfAborted();
  const created = (await httpClient.request('post', '/v2/projects', {
    signal,
    body: { name: projectName },
  })) as { id?: unknown };
  if (typeof created?.id !== 'string') {
    throw new Error('Sync created a project without returning its id.');
  }

  return created.id;
}

/**
 * Hand-written tools layered on top of the auto-generated ones.
 *
 * `create-lipsync` is a flat convenience wrapper over POST /v2/generate (the
 * auto-generated generate_create-generation takes a nested `input[]` array).
 *
 * Each media input can arrive three ways:
 *  - `*Url` string — a hosted/public URL, e.g. the `url` returned by tts_create
 *    or an asset URL. This is the only way to chain another tool's output (the
 *    model can't synthesise a fileParam object), and it's passed straight to
 *    the generation as `url`.
 *  - `*AssetId` string — a durable Sync asset created earlier, typically by
 *    upload-media. This keeps uploaded-file handling separate from generation
 *    creation when the host supports file params but should not pass the file
 *    directly to the generation tool. For public URLs, use the explicit `*Url`
 *    fields or the generated assets_create tool instead.
 *  - `video`/`image`/`audio` file objects — declared as `openai/fileParams` so
 *    ChatGPT can hand a user-uploaded file straight in. These carry a
 *    short-lived `download_url`, so we re-host the bytes through the assets
 *    pipeline and pass a durable `assetId` (see rehostUpload).
 *
 * The generation can be driven by either audio (`audioUrl`/`audioAssetId`/
 * `audio`) or text (`script` + `voiceId`). Text is sent directly to POST
 * /v2/generate as a text input, avoiding a separate tts_create call.
 */
export function createAppTools(
  httpClient: HttpClient,
  runtime: UploadRuntime = uploadRuntime,
  getProfile: () => ClientProfile = () => resolveClientProfile(),
): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [
    {
      name: 'upload-media',
      title: 'Upload media',
      description:
        'Stage an image, video, or audio file in Sync asset storage and return a durable assetId. ' +
        'The file must be a host-provided object with a temporary HTTP download URL. Public URL strings are not accepted. ' +
        'This creates a media asset but does not start a lipsync generation.',
      inputSchema: {
        mediaType: z
          .enum(['video', 'image', 'audio'])
          .describe('Type of media being uploaded: image, video, or audio.'),
        file: z
          .object(fileInput.shape)
          .describe('Uploaded media file from ChatGPT. Do not pass URL strings here.'),
      },
      outputSchema: uploadMediaOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      meta: {
        ui: { visibility: ['model', 'app'] },
        'openai/fileParams': ['file'],
        'openai/widgetAccessible': true,
        'openai/toolInvocation/invoking': 'Uploading media to Sync…',
        'openai/toolInvocation/invoked': 'Media uploaded to Sync.',
      },
      handler: async (args, context) => {
        const signal = context?.signal;
        signal?.throwIfAborted();
        const { mediaType, file } = args as {
          mediaType?: MediaKind;
          file?: MediaParam;
        };

        if (!mediaType || !['video', 'image', 'audio'].includes(mediaType)) {
          throw new Error('mediaType is required and must be one of: video, image, audio.');
        }
        if (!file) {
          throw new Error('file is required — pass the uploaded ChatGPT file object.');
        }
        if (typeof file === 'string') {
          throw new Error(
            `Got a string in the file slot ("${file.slice(0, 80)}"). ` +
              'This tool only accepts uploaded ChatGPT file objects; pass public URLs to assets_create or create-lipsync.',
          );
        }

        const assetId = await uploadMediaAsset(httpClient, mediaType, file, runtime, signal);
        return {
          assetId,
          mediaType,
          assetType: ASSET_TYPE_BY_KIND[mediaType],
          input: { type: mediaType, assetId },
        };
      },
    },
    {
      name: 'create-lipsync',
      title: 'Create lipsync',
      description:
        'Use this when the user wants to make a photo talk, make an image or video say a script, or match a speaker’s lip movements to supplied audio. ' +
        'Create a lipsync video with exactly one visual input (image or video) and one driver (audio or script). ' +
        'For translating spoken video into another language, use create-translate-and-dub when available. Do not use for subtitles only, standalone audio, or general video editing. ' +
        'Inputs can be public URLs, Sync asset IDs, or supported host file objects. A script requires a voiceId. ' +
        'The model defaults to sync-3. Supply projectId to use an existing project, or projectName to find or create one. When neither is supplied, an integration-specific default project is used. ' +
        'Before confirming, estimate using the replacement script or measured audio duration, not the source video length. Script-based quotes are approximate and exclude speech synthesis. ' +
        'This starts an asynchronous generation and returns its id and status.',
      inputSchema: {
        continuation: generationContextSchema.optional(),
        videoUrl: z
          .string()
          .describe(
            'Public or Sync-hosted video URL. Use exactly one of videoUrl/videoAssetId/video/imageUrl/imageAssetId/image.',
          )
          .optional(),
        videoAssetId: z
          .string()
          .describe(
            'Sync asset id for a video, returned by upload-media or assets_create. Use exactly one visual input.',
          )
          .optional(),
        imageUrl: z
          .string()
          .describe(
            'Public or Sync-hosted still image URL. Use this for image-to-video lipsync with sync-3.',
          )
          .optional(),
        imageAssetId: z
          .string()
          .describe(
            'Sync asset id for a still image, returned by upload-media or assets_create. Use this for image-to-video lipsync with sync-3.',
          )
          .optional(),
        audioUrl: z
          .string()
          .describe('Public or Sync-hosted audio URL. Use this when the user supplies audio.')
          .optional(),
        audioAssetId: z
          .string()
          .describe('Sync asset id for audio, returned by upload-media or assets_create.')
          .optional(),
        script: z.string().describe('Text for the image or video to say.').optional(),
        voiceId: z
          .string()
          .describe('Voice id from voices_get-voices. Required when script is provided.')
          .optional(),
        provider: z
          .string()
          .describe('Voice provider for script-driven lipsync. Defaults to elevenlabs.')
          .optional(),
        stability: z
          .number()
          .describe('Optional ElevenLabs voice stability for script input.')
          .optional(),
        similarityBoost: z
          .number()
          .describe('Optional ElevenLabs similarity boost for script input.')
          .optional(),
        video: z
          .object(fileInput.shape)
          .describe('Uploaded video file from ChatGPT. Use videoUrl for public URLs instead.')
          .optional(),
        image: z
          .object(fileInput.shape)
          .describe('Uploaded still image file from ChatGPT. Use imageUrl for public URLs instead.')
          .optional(),
        audio: z
          .object(fileInput.shape)
          .describe('Uploaded audio file from ChatGPT. Use audioUrl for public URLs instead.')
          .optional(),
        model: z
          .string()
          .describe('Optional model override. Image and video inputs default to sync-3.')
          .optional(),
        options: modelOptionsSchema
          .optional()
          .describe(
            'Model-specific generation preferences. Keep unchanged when retrying the same idempotency key.',
          ),
        idempotencyKey: z
          .string()
          .regex(/^[A-Za-z0-9._~-]{1,128}$/)
          .describe(
            'Unique key for one generation action. Persist and reuse the same key, projectId, model, and inputs when retrying after a lost response. Use durable asset IDs or stable URLs; upload files before starting the keyed action. A new intentional generation needs a new key. Passed as the Sync API Idempotency-Key header.',
          )
          .optional(),
        projectId: z
          .string()
          .trim()
          .min(1)
          .describe(
            'Existing Sync project ID returned by projects_get-all or projects_get. Use this to select the same project as the web app. Cannot be combined with projectName.',
          )
          .optional(),
        projectName: z
          .string()
          .trim()
          .min(1)
          .describe(
            'Project name to find or create. Cannot be combined with projectId. When both are omitted, the tool uses an integration-specific default. An existing project with the same name is reused, or a new one is created.',
          )
          .optional(),
      },
      outputSchema: generationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      meta: {
        'openai/fileParams': ['video', 'image', 'audio'],
        'openai/toolInvocation/invoking': 'Creating your lipsync video…',
        'openai/toolInvocation/invoked': 'Lipsync generation started.',
      },
      handler: async (args, context) => {
        const signal = context?.signal;
        signal?.throwIfAborted();
        const {
          videoUrl,
          videoAssetId,
          imageUrl,
          imageAssetId,
          audioUrl,
          audioAssetId,
          script,
          voiceId,
          provider,
          stability,
          similarityBoost,
          video,
          image,
          audio,
          model,
          projectName,
          projectId: requestedProjectId,
          idempotencyKey,
        } = args as {
          videoUrl?: string;
          videoAssetId?: string;
          imageUrl?: string;
          imageAssetId?: string;
          audioUrl?: string;
          audioAssetId?: string;
          script?: string;
          voiceId?: string;
          provider?: string;
          stability?: number;
          similarityBoost?: number;
          video?: MediaParam;
          image?: MediaParam;
          audio?: MediaParam;
          model?: string;
          projectName?: string;
          projectId?: string;
          idempotencyKey?: string;
        };

        const options = modelOptionsSchema.optional().parse(args.options);
        if (args.continuation !== undefined) {
          generationContextSchema.parse(args.continuation);
          z.uuid().parse(requestedProjectId);
        }
        if (typeof options?.active_speaker_detection === 'boolean') {
          options.active_speaker_detection = { auto_detect: options.active_speaker_detection };
        }

        // Validate the shape up front, before re-hosting any bytes.
        const audioSourceCount = providedCount(audioUrl, audioAssetId, audio);
        const videoSourceCount = providedCount(videoUrl, videoAssetId, video);
        const imageSourceCount = providedCount(imageUrl, imageAssetId, image);
        assertSingleSource('audio', audioSourceCount);
        assertSingleSource('video', videoSourceCount);
        assertSingleSource('image', imageSourceCount);

        const hasAudio = audioSourceCount > 0;
        const hasScript = Boolean(script);
        const hasVideo = videoSourceCount > 0;
        const hasImage = imageSourceCount > 0;

        if (!hasAudio && !hasScript) {
          throw new Error(
            'Audio or script is required - pass `audioAssetId`, or pass `script` with a `voiceId` from voices_get-voices. create-lipsync also accepts `audioUrl` or an uploaded audio file.',
          );
        }
        if (hasAudio && hasScript) {
          throw new Error('Provide either audio or script, not both.');
        }
        if (hasScript && !voiceId) {
          throw new Error('voiceId is required when using script — call voices_get-voices first.');
        }
        if (!hasVideo && !hasImage) {
          throw new Error(
            'Provide a video or an image - pass `videoAssetId` or `imageAssetId`. create-lipsync also accepts `videoUrl`/`imageUrl` or an uploaded file.',
          );
        }
        if (hasVideo && hasImage) {
          throw new Error('Provide either a video or an image, not both.');
        }

        if (requestedProjectId !== undefined && !requestedProjectId.trim()) {
          throw new Error('projectId must not be empty.');
        }
        if (requestedProjectId !== undefined && projectName !== undefined) {
          throw new Error('Provide either projectId or projectName, not both.');
        }
        if (projectName !== undefined && !projectName.trim()) {
          throw new Error('projectName must not be empty.');
        }

        // Reject malformed ChatGPT file params before making project or upload requests.
        assertValidFileParam('video', video);
        assertValidFileParam('image', image);
        assertValidFileParam('audio', audio);

        const projectId =
          requestedProjectId?.trim() ??
          (await getOrCreateProjectId(
            httpClient,
            projectName,
            (context?.clientProfile ?? getProfile()).defaultProjectName,
            signal,
          ));
        if (requestedProjectId !== undefined) {
          // Check access before transferring files. Generation admission checks it again.
          await httpClient.request('get', `/v2/projects/${encodeURIComponent(projectId)}`, {
            signal,
          });
        }

        const lineage = await generationContextHeaders(
          httpClient,
          args,
          ['lipsync', 'image_to_video', 'translate_and_dub'],
          signal,
        );

        // URLs go through verbatim; uploaded files are re-hosted; assetIds are reused.
        const driver = hasScript
          ? {
              type: 'text',
              provider: {
                name: provider ?? 'elevenlabs',
                voiceId,
                script,
                ...(stability === undefined ? {} : { stability }),
                ...(similarityBoost === undefined ? {} : { similarityBoost }),
              },
            }
          : await resolveMedia(httpClient, 'audio', audioUrl, audioAssetId, audio, runtime, signal);
        const visual = hasImage
          ? await resolveMedia(httpClient, 'image', imageUrl, imageAssetId, image, runtime, signal)
          : await resolveMedia(httpClient, 'video', videoUrl, videoAssetId, video, runtime, signal);

        const resolvedModel = model ?? 'sync-3';

        signal?.throwIfAborted();
        return httpClient.request('post', '/v2/generate', {
          signal,
          ...(idempotencyKey || Object.keys(lineage).length
            ? {
                headers: {
                  ...lineage,
                  ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
                },
              }
            : {}),
          body: {
            model: resolvedModel,
            ...(options === undefined ? {} : { options }),
            input: [visual, driver],
            projectId,
          },
        });
      },
    },
  ];
  const lipsync = tools.find((tool) => tool.name === 'create-lipsync')!;
  // Embedded apps cannot invoke tools annotated with fileParams, even with
  // asset-only arguments. Reuse generation admission/execution without exposing
  // the host's attachment transport to this app-only entry point.
  const inputSchema = { ...lipsync.inputSchema };
  for (const key of ['video', 'image', 'audio', 'videoUrl', 'imageUrl', 'audioUrl']) {
    delete inputSchema[key];
  }
  const { 'openai/fileParams': _fileParams, ...meta } = lipsync.meta ?? {};
  tools.push({
    ...lipsync,
    name: 'create-lipsync-from-assets',
    description:
      'Create one lipsync generation from saved Sync image/video and audio asset IDs, or a saved visual asset plus script and voiceId. Uses the same project access, options, and idempotency rules as create-lipsync. For embedded Sync interfaces only.',
    inputSchema,
    meta: { ...meta, ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
  });
  return tools;
}
