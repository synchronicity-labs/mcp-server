import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

// A file as ChatGPT delivers it for an `openai/fileParams` field.
const fileInput = z.object({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

type FileInput = z.infer<typeof fileInput>;
type MediaKind = 'video' | 'image' | 'audio';
type ResolvedMedia = { type: MediaKind; url?: string; assetId?: string };

const ASSET_TYPE_BY_KIND: Record<MediaKind, 'VIDEO' | 'IMAGE' | 'AUDIO'> = {
  video: 'VIDEO',
  image: 'IMAGE',
  audio: 'AUDIO',
};

const DEFAULT_CONTENT_TYPE: Record<MediaKind, string> = {
  video: 'video/mp4',
  image: 'image/png',
  audio: 'audio/mpeg',
};

// The host of a URL, for error messages — so a failure says *where* it tried to
// reach, not just "fetch failed".
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

// Node's fetch throws `TypeError: fetch failed` and hides the real reason (DNS,
// TLS, connection refused, unsupported protocol) on `.cause`. Surface it.
function reason(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${err.message} — ${cause.message}`;
    return err.message;
  }
  return String(err);
}

/**
 * Copy a user-uploaded file into Sync storage and return its durable assetId.
 *
 * ChatGPT hands an uploaded file to the tool as a short-lived `download_url`
 * (it is only valid while this tool call is being handled). A Sync generation,
 * though, fetches its input media asynchronously on the worker — long after
 * this call returns — by which point the ChatGPT URL is dead. So we pull the
 * bytes now and re-host them through the assets pipeline; the returned assetId
 * resolves to a durable Sync URL at submit time and survives the job queue.
 *
 * Each hop throws a distinct, host-tagged error: the three external steps
 * (download from ChatGPT, PUT to Sync storage, register) fail in different ways
 * and a bare "fetch failed" can't be acted on — by the model or by us.
 */
async function rehostUpload(
  httpClient: HttpClient,
  file: FileInput,
  kind: MediaKind,
): Promise<string> {
  const src = file.download_url;
  if (!src) {
    throw new Error(`The uploaded ${kind} is missing its download_url.`);
  }
  // A real upload is an http(s) URL we can fetch. A sandbox/local reference
  // (e.g. "sandbox:/mnt/data/...") can't be re-hosted — tell the caller to pass
  // a public URL instead, and echo the value so the cause is visible.
  if (!/^https?:\/\//i.test(src)) {
    throw new Error(
      `The uploaded ${kind} isn't a fetchable URL (received "${src.slice(0, 80)}"). ` +
        `Pass a public ${kind} URL via ${kind}Url instead.`,
    );
  }

  // 1. Download the bytes from ChatGPT's temporary URL.
  let download: Response;
  try {
    download = await fetch(src);
  } catch (err) {
    throw new Error(`Could not reach the uploaded ${kind} at ${hostOf(src)}: ${reason(err)}.`);
  }
  if (!download.ok) {
    throw new Error(`The uploaded ${kind} URL returned HTTP ${download.status}.`);
  }
  const bytes = await download.arrayBuffer();
  const contentType =
    download.headers.get('content-type') ?? file.mime_type ?? DEFAULT_CONTENT_TYPE[kind];
  const fileName = file.file_name ?? `chatgpt-upload-${kind}`;

  // 2. Ask Sync for a presigned upload URL.
  const { uploadUrl, url } = (await httpClient.request('post', '/v2/assets/upload', {
    body: { fileName, contentType, size: bytes.byteLength },
  })) as { uploadUrl: string; url: string };

  // 3. Upload the bytes to Sync storage.
  let put: Response;
  try {
    put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: bytes,
    });
  } catch (err) {
    throw new Error(
      `Could not upload the ${kind} to Sync storage at ${hostOf(uploadUrl)}: ${reason(err)}.`,
    );
  }
  if (!put.ok) {
    throw new Error(`Sync storage rejected the ${kind} upload (HTTP ${put.status}).`);
  }

  // 4. Register the uploaded object as an asset.
  const asset = (await httpClient.request('post', '/v2/assets', {
    body: { url, type: ASSET_TYPE_BY_KIND[kind] },
  })) as { id: string };

  return asset.id;
}

// A media slot can be filled by an explicit `*Url`, a Sync asset id, or by the
// fileParam object declared in `openai/fileParams`. `string` is kept here only
// to reject malformed direct handler calls with a useful error.
type MediaParam = string | FileInput | undefined;

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

async function uploadMediaAsset(
  httpClient: HttpClient,
  kind: MediaKind,
  fileParam: FileInput,
): Promise<string> {
  return rehostUpload(httpClient, fileParam, kind);
}

async function resolveMedia(
  httpClient: HttpClient,
  kind: MediaKind,
  urlParam: string | undefined,
  assetIdParam: string | undefined,
  fileParam: MediaParam,
): Promise<ResolvedMedia> {
  if (assetIdParam) return { type: kind, assetId: assetIdParam };

  // An explicit URL the model already holds (tts output, public/asset URL) wins.
  if (urlParam) return { type: kind, url: urlParam };

  if (typeof fileParam === 'string') {
    throw new Error(
      `Got a string in the ${kind} file slot ("${fileParam.slice(0, 80)}"). ` +
        `Pass public URLs via ${kind}Url instead; file slots must be ChatGPT file objects.`,
    );
  }

  if (fileParam) {
    return { type: kind, assetId: await rehostUpload(httpClient, fileParam, kind) };
  }

  // Unreachable — callers validate presence first.
  throw new Error(`No ${kind} provided.`);
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
export function createAppTools(httpClient: HttpClient): McpToolDefinition[] {
  return [
    {
      name: 'upload-media',
      title: 'Upload media',
      description:
        'Upload a user-provided image, video, or audio file to Sync asset storage and return a durable assetId. ' +
        'Use this when the user uploaded media in chat and a later Sync tool call should reference it by assetId. ' +
        'The file field must be the uploaded ChatGPT file object. For public URLs, use assets_create or pass the URL directly to create-lipsync. ' +
        'This tool only stores the media; it does not create a lipsync generation. After it returns, pass the assetId to create-lipsync as imageAssetId, videoAssetId, or audioAssetId.',
      inputSchema: {
        mediaType: z
          .enum(['video', 'image', 'audio'])
          .describe('Type of media being uploaded: image, video, or audio.'),
        file: z
          .object(fileInput.shape)
          .describe('Uploaded media file from ChatGPT. Do not pass URL strings here.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      meta: {
        ui: { visibility: ['model', 'app'] },
        'openai/fileParams': ['file'],
        'openai/widgetAccessible': true,
        'openai/toolInvocation/invoking': 'Uploading media to Sync…',
        'openai/toolInvocation/invoked': 'Media uploaded to Sync.',
      },
      handler: async (args) => {
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

        const assetId = await uploadMediaAsset(httpClient, mediaType, file);
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
        'Create a lipsync video from audio + EITHER a video or a still image (an image drives sync-3 image-to-video). ' +
        'For "make this image/video say X" requests, pass `script` with a `voiceId` from voices_get-voices; do not call tts_create first. ' +
        'Pass URLs whenever you have them — set `audioUrl` to any public audio URL, and `videoUrl`/`imageUrl` to a hosted media URL. ' +
        'If media was uploaded to Sync first, pass `audioAssetId`, `videoAssetId`, or `imageAssetId`. ' +
        'For files the user uploaded in chat, prefer calling upload-media first and pass the returned assetId here; direct `audio`/`video`/`image` file params are supported when a host invokes this tool with file params directly. ' +
        'Provide exactly one visual input (video or image) and exactly one driver input (audio or script). Returns a generation id — poll generate_get-generation until status is COMPLETED, then read outputUrl. ' +
        'For advanced options (segments, speaker selection), use generate_create-generation.',
      inputSchema: {
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
        script: z
          .string()
          .describe(
            'Text for the image or video to say. For "make this say X", pass X here directly instead of calling tts_create.',
          )
          .optional(),
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
          .describe(
            'Optional model override. Defaults to sync-3 for image input and lipsync-2 for video.',
          )
          .optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      meta: {
        'openai/fileParams': ['video', 'image', 'audio'],
        'openai/toolInvocation/invoking': 'Creating your lipsync video…',
        'openai/toolInvocation/invoked': 'Lipsync generation started.',
      },
      handler: async (args) => {
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
        };

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
            'Audio or script is required — pass `audioUrl`/upload audio, or pass `script` with a `voiceId` from voices_get-voices.',
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
            'Provide a video or an image — pass `videoUrl`/`imageUrl` or upload a file.',
          );
        }
        if (hasVideo && hasImage) {
          throw new Error('Provide either a video or an image, not both.');
        }

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
          : await resolveMedia(httpClient, 'audio', audioUrl, audioAssetId, audio);
        const visual = hasImage
          ? await resolveMedia(httpClient, 'image', imageUrl, imageAssetId, image)
          : await resolveMedia(httpClient, 'video', videoUrl, videoAssetId, video);

        // Image-to-video is only supported by sync-3; default the model to match.
        const resolvedModel = model ?? (hasImage ? 'sync-3' : 'lipsync-2');

        return httpClient.request('post', '/v2/generate', {
          body: {
            model: resolvedModel,
            input: [visual, driver],
          },
        });
      },
    },
  ];
}
