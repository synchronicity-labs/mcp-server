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

// A media slot can be filled by an explicit `*Url`, or by the fileParam — which
// arrives either as a real file object (re-host it) or, on hosts that don't
// attach uploads (e.g. ChatGPT dev mode passes the model's own "/mnt/data/..."
// path), as a bare string. Resolve all of these to a generation input item.
type MediaParam = string | FileInput | undefined;

async function resolveMedia(
  httpClient: HttpClient,
  kind: MediaKind,
  urlParam: string | undefined,
  fileParam: MediaParam,
): Promise<{ type: string; url?: string; assetId?: string }> {
  // An explicit URL the model already holds (tts output, public/asset URL) wins.
  if (urlParam) return { type: kind, url: urlParam };

  if (typeof fileParam === 'string') {
    if (/^https?:\/\//i.test(fileParam)) return { type: kind, url: fileParam };
    // A non-URL string is a host-local reference we can't fetch — say so.
    throw new Error(
      `Got a local path for the ${kind} ("${fileParam.slice(0, 80)}"), not an uploadable file — ` +
        `this host didn't attach the upload. Pass a public ${kind} URL via ${kind}Url instead.`,
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
 * Each media input can arrive two ways:
 *  - `*Url` string — a hosted/public URL, e.g. the `url` returned by tts_create
 *    or an asset URL. This is the only way to chain another tool's output (the
 *    model can't synthesise a fileParam object), and it's passed straight to
 *    the generation as `url`.
 *  - `video`/`image`/`audio` file objects — declared as `openai/fileParams` so
 *    ChatGPT can hand a user-uploaded file straight in. These carry a
 *    short-lived `download_url`, so we re-host the bytes through the assets
 *    pipeline and pass a durable `assetId` (see rehostUpload).
 *
 * The generation can be driven by either audio (`audioUrl`/`audio`) or text
 * (`script` + `voiceId`). Text is sent directly to POST /v2/generate as a text
 * input, avoiding a separate tts_create call.
 */
export function createAppTools(httpClient: HttpClient): McpToolDefinition[] {
  return [
    {
      name: 'create-lipsync',
      title: 'Create lipsync',
      description:
        'Create a lipsync video from audio + EITHER a video or a still image (an image drives sync-3 image-to-video). ' +
        'For "make this image/video say X" requests, pass `script` with a `voiceId` from voices_get-voices; do not call tts_create first. ' +
        'Pass URLs whenever you have them — set `audioUrl` to any public audio URL, and `videoUrl`/`imageUrl` to a hosted media URL. ' +
        'Files a user uploaded in chat arrive via the `audio`/`video`/`image` file params instead. ' +
        'Provide exactly one visual input (video or image) and exactly one driver input (audio or script). Returns a generation id — poll generate_get-generation until status is COMPLETED, then read outputUrl. ' +
        'For assetId inputs or advanced options (segments, speaker selection), use generate_create-generation.',
      inputSchema: {
        videoUrl: z.string().optional(),
        imageUrl: z.string().optional(),
        audioUrl: z.string().optional(),
        script: z.string().optional(),
        voiceId: z.string().optional(),
        provider: z.string().optional(),
        stability: z.number().optional(),
        similarityBoost: z.number().optional(),
        video: z.union([z.string(), fileInput]).optional(),
        image: z.union([z.string(), fileInput]).optional(),
        audio: z.union([z.string(), fileInput]).optional(),
        model: z.string().optional(),
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
          imageUrl,
          audioUrl,
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
          imageUrl?: string;
          audioUrl?: string;
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
        const hasAudio = Boolean(audioUrl || audio);
        const hasScript = Boolean(script);
        const hasVideo = Boolean(videoUrl || video);
        const hasImage = Boolean(imageUrl || image);

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

        // A URL goes through verbatim; an uploaded file is re-hosted to an assetId.
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
          : await resolveMedia(httpClient, 'audio', audioUrl, audio);
        const visual = hasImage
          ? await resolveMedia(httpClient, 'image', imageUrl, image)
          : await resolveMedia(httpClient, 'video', videoUrl, video);

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
