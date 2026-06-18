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

/**
 * Copy a user-uploaded file into Sync storage and return its durable assetId.
 *
 * ChatGPT hands an uploaded file to the tool as a short-lived `download_url`
 * (it is only valid while this tool call is being handled). A Sync generation,
 * though, fetches its input media asynchronously on the worker — long after
 * this call returns — by which point the ChatGPT URL is dead. So we pull the
 * bytes now and re-host them through the assets pipeline; the returned assetId
 * resolves to a durable Sync URL at submit time and survives the job queue.
 */
async function rehostUpload(
  httpClient: HttpClient,
  file: FileInput,
  kind: MediaKind,
): Promise<string> {
  if (!file.download_url) {
    throw new Error(`The uploaded ${kind} is missing its download_url.`);
  }

  const download = await fetch(file.download_url);
  if (!download.ok) {
    throw new Error(`Could not read the uploaded ${kind} (HTTP ${download.status}).`);
  }
  const bytes = await download.arrayBuffer();
  const contentType =
    download.headers.get('content-type') ?? file.mime_type ?? DEFAULT_CONTENT_TYPE[kind];
  const fileName = file.file_name ?? `chatgpt-upload-${kind}`;

  const { uploadUrl, url } = (await httpClient.request('post', '/v2/assets/upload', {
    body: { fileName, contentType, size: bytes.byteLength },
  })) as { uploadUrl: string; url: string };

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`Failed to store the uploaded ${kind} in Sync (HTTP ${put.status}).`);
  }

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
