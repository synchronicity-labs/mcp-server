import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

// A file as ChatGPT delivers it for an `openai/fileParams` field. Only
// download_url is needed to pull the bytes; the rest is metadata ChatGPT
// includes.
const fileInput = z.object({
  download_url: z.string(),
  file_id: z.string().optional(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

type FileInput = { download_url?: string; mime_type?: string; file_name?: string };
type MediaKind = 'video' | 'image' | 'audio';

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

/**
 * Hand-written tools layered on top of the auto-generated ones.
 *
 * `create-lipsync` is a flat convenience wrapper over POST /v2/generate (the
 * auto-generated generate_create-generation takes a nested `input[]` array).
 *
 * Each media input can arrive two ways:
 *  - `*Url` string — a hosted/public URL, e.g. the `url` returned by tts_create
 *    or an asset URL. This is the only way to chain another tool's output (the
 *    model can't synthesise a fileParam object), and it's passed straight to
 *    the generation as `url`.
 *  - `video`/`image`/`audio` file objects — declared as `openai/fileParams` so
 *    ChatGPT can hand a user-uploaded file straight in. These carry a
 *    short-lived `download_url`, so we re-host the bytes through the assets
 *    pipeline and pass a durable `assetId` (see rehostUpload).
 */
export function createAppTools(httpClient: HttpClient): McpToolDefinition[] {
  return [
    {
      name: 'create-lipsync',
      description:
        'Create a lipsync video from audio + EITHER a video or a still image (an image drives sync-3 image-to-video). ' +
        'Pass URLs whenever you have them — set `audioUrl` to the `url` returned by tts_create (or any public audio URL), and `videoUrl`/`imageUrl` to a hosted media URL. ' +
        'Files a user uploaded in chat arrive via the `audio`/`video`/`image` file params instead. ' +
        'Provide audio plus exactly one of video or image. Returns a generation id — poll generate_get-generation until status is COMPLETED, then read outputUrl. ' +
        'For assetId inputs or advanced options (segments, speaker selection), use generate_create-generation.',
      inputSchema: {
        videoUrl: z.string().optional(),
        imageUrl: z.string().optional(),
        audioUrl: z.string().optional(),
        video: fileInput.optional(),
        image: fileInput.optional(),
        audio: fileInput.optional(),
        model: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      meta: {
        'openai/fileParams': ['video', 'image', 'audio'],
        'openai/toolInvocation/invoking': 'Creating your lipsync video…',
        'openai/toolInvocation/invoked': 'Lipsync generation started.',
      },
      handler: async (args) => {
        const { videoUrl, imageUrl, audioUrl, video, image, audio, model } = args as {
          videoUrl?: string;
          imageUrl?: string;
          audioUrl?: string;
          video?: FileInput;
          image?: FileInput;
          audio?: FileInput;
          model?: string;
        };

        // Validate the shape up front, before re-hosting any bytes.
        const hasAudio = Boolean(audioUrl || audio?.download_url);
        const hasVideo = Boolean(videoUrl || video?.download_url);
        const hasImage = Boolean(imageUrl || image?.download_url);

        if (!hasAudio) {
          throw new Error(
            'Audio is required — pass `audioUrl` (e.g. the url from tts_create) or upload an audio file.',
          );
        }
        if (!hasVideo && !hasImage) {
          throw new Error(
            'Provide a video or an image — pass `videoUrl`/`imageUrl` or upload a file.',
          );
        }
        if (hasVideo && hasImage) {
          throw new Error('Provide either a video or an image, not both.');
        }

        // A URL goes through verbatim; an uploaded file is re-hosted to an assetId.
        const audioItem = audioUrl
          ? { type: 'audio', url: audioUrl }
          : { type: 'audio', assetId: await rehostUpload(httpClient, audio as FileInput, 'audio') };

        let visual: { type: string; url?: string; assetId?: string };
        if (hasImage) {
          visual = imageUrl
            ? { type: 'image', url: imageUrl }
            : {
                type: 'image',
                assetId: await rehostUpload(httpClient, image as FileInput, 'image'),
              };
        } else {
          visual = videoUrl
            ? { type: 'video', url: videoUrl }
            : {
                type: 'video',
                assetId: await rehostUpload(httpClient, video as FileInput, 'video'),
              };
        }

        // Image-to-video is only supported by sync-3; default the model to match.
        const resolvedModel = model ?? (hasImage ? 'sync-3' : 'lipsync-2');

        return httpClient.request('post', '/v2/generate', {
          body: {
            model: resolvedModel,
            input: [visual, audioItem],
          },
        });
      },
    },
  ];
}
