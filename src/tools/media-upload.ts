import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { UploadRuntime } from '../upload-runtime.js';
import { createUploadSourceDispatcher, validatedUploadSourceUrl } from '../upload-source.js';

// A file as ChatGPT delivers it for an `openai/fileParams` field.
export const fileInput = z.object({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

export type FileInput = z.infer<typeof fileInput>;
export type MediaKind = 'video' | 'image' | 'audio';
type ResolvedMedia = { type: MediaKind; url?: string; assetId?: string };

export const ASSET_TYPE_BY_KIND: Record<MediaKind, 'VIDEO' | 'IMAGE' | 'AUDIO'> = {
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

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the actionable validation or upstream error that caused cancellation.
  }
}

function validatedUploadUrl(file: FileInput, kind: MediaKind): string {
  const src = file.download_url;
  if (!src) {
    throw new Error(`The uploaded ${kind} is missing its download_url.`);
  }
  if (!/^https?:\/\//i.test(src)) {
    throw new Error(
      `The uploaded ${kind} isn't a fetchable URL (received "${src.slice(0, 80)}"). ` +
        `Pass a public ${kind} URL via ${kind}Url instead.`,
    );
  }
  return validatedUploadSourceUrl(src);
}

/**
 * Copy a media file into Sync storage and return its durable assetId.
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
  runtime: UploadRuntime,
  signal: AbortSignal,
  assetDetails: { projectId?: string; name?: string } = {},
): Promise<string> {
  // A real upload is an http(s) URL we can fetch. A sandbox/local reference
  // (e.g. "sandbox:/mnt/data/...") can't be re-hosted — tell the caller to pass
  // a public URL instead, and echo the value so the cause is visible.
  signal.throwIfAborted();
  const src = validatedUploadUrl(file, kind);
  const dispatcher = createUploadSourceDispatcher(signal);
  let download: Response | undefined;
  let tempDirectory: string | undefined;
  let tempPath: string | undefined;
  let uploadBody: ReturnType<typeof createReadStream> | undefined;
  let put: Response | undefined;
  let downloadPipelineStarted = false;
  let actualSize = 0;

  try {
    // 1. Download the source through the public-destination guard.
    try {
      download = await fetch(src, { signal, dispatcher, redirect: 'error' });
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      throw new Error(`Could not reach the uploaded ${kind} at ${hostOf(src)}: ${reason(err)}.`, { cause: err });
    }
    if (!download.ok) {
      await cancelResponseBody(download);
      throw new Error(`The uploaded ${kind} URL returned HTTP ${download.status}.`);
    }
    const contentType =
      download.headers.get('content-type') ?? file.mime_type ?? DEFAULT_CONTENT_TYPE[kind];
    const fileName = file.file_name ?? `chatgpt-upload-${kind}`;

    const declaredSizeHeader = download.headers.get('content-length');
    const declaredSize = declaredSizeHeader === null ? undefined : Number(declaredSizeHeader);
    const encodings = (download.headers.get('content-encoding') ?? '')
      .split(',')
      .map((encoding: string) => encoding.trim().toLowerCase());
    const compressedEncodings = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'zstd']);
    const hasEncodedBody = encodings.some((encoding: string) => compressedEncodings.has(encoding));
    if (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) {
      await cancelResponseBody(download);
      throw new Error(`The uploaded ${kind} has an invalid Content-Length header.`);
    }
    if (declaredSize !== undefined && declaredSize > runtime.config.maxBytes) {
      await cancelResponseBody(download);
      throw new Error(
        `The uploaded ${kind} is too large (${declaredSize} bytes; limit ${runtime.config.maxBytes} bytes).`,
      );
    }
    if (!download.body) {
      await cancelResponseBody(download);
      throw new Error(`The uploaded ${kind} response did not include a body.`);
    }

    tempDirectory = await mkdtemp(join(tmpdir(), 'sync-mcp-upload-'));
    tempPath = join(tempDirectory, 'upload');
    const validateSize = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        actualSize += chunk.byteLength;
        runtime.recordDownloadedBytes(chunk.byteLength);
        if (actualSize > runtime.config.maxBytes) {
          callback(
            new Error(
              `The uploaded ${kind} is too large (limit ${runtime.config.maxBytes} bytes).`,
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    downloadPipelineStarted = true;
    await pipeline(
      Readable.fromWeb(download.body),
      validateSize,
      createWriteStream(tempPath, { flags: 'wx' }),
      { signal },
    );

    if (declaredSize !== undefined && !hasEncodedBody && actualSize !== declaredSize) {
      throw new Error(
        `The uploaded ${kind} size did not match Content-Length (expected ${declaredSize}, received ${actualSize}).`,
      );
    }

    // 2. Ask Sync for a presigned upload URL after the bounded stream has been measured.
    signal.throwIfAborted();
    const { uploadUrl, url } = (await httpClient.request('post', '/v2/assets/upload', {
      body: { fileName, contentType, size: actualSize },
      signal,
    })) as { uploadUrl: string; url: string };

    // 3. Upload from disk so large and unknown-length inputs never occupy one large buffer.
    signal.throwIfAborted();
    uploadBody = createReadStream(tempPath);
    try {
      put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'Content-Length': String(actualSize) },
        body: uploadBody,
        duplex: 'half',
        // Redirect replay tees the stream and retains a full upload in memory.
        redirect: 'error',
        signal,
      });
    } catch (err) {
      uploadBody.destroy();
      throw new Error(
        `Could not upload the ${kind} to Sync storage at ${hostOf(uploadUrl)}: ${reason(err)}.`, { cause: err },
      );
    }
    if (!put.ok) {
      throw new Error(`Sync storage rejected the ${kind} upload (HTTP ${put.status}).`);
    }
    await finished(uploadBody, { signal });
    runtime.recordUploadedBytes(actualSize);

    // 4. Register the uploaded object as an asset.
    signal.throwIfAborted();
    const asset = (await httpClient.request('post', '/v2/assets', {
      body: { url, type: ASSET_TYPE_BY_KIND[kind], ...assetDetails },
      signal,
    })) as { id: string };

    return asset.id;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    uploadBody?.destroy();
    if (put) await cancelResponseBody(put);
    if (download && !downloadPipelineStarted) await cancelResponseBody(download);
    await dispatcher.destroy().catch(() => runtime.recordCleanupFailure());
    if (tempDirectory) {
      try {
        await rm(tempDirectory, { recursive: true, force: true });
      } catch {
        // Cleanup must not replace a durable asset ID or the primary upload error.
        // Count failures without exposing local paths or sensitive error details.
        runtime.recordCleanupFailure();
      }
    }
  }
}

// A media slot can be filled by an explicit `*Url`, a Sync asset id, or by the
// fileParam object declared in `openai/fileParams`. `string` is kept here only
// to reject malformed direct handler calls with a useful error.
export type MediaParam = string | FileInput | undefined;

export function assertValidFileParam(
  kind: MediaKind,
  fileParam: MediaParam,
): asserts fileParam is FileInput | undefined {
  if (typeof fileParam === 'string') {
    throw new Error(
      `Got a string in the ${kind} file slot ("${fileParam.slice(0, 80)}"). ` +
        `Pass public URLs via ${kind}Url instead; file slots must be ChatGPT file objects.`,
    );
  }
  if (fileParam) validatedUploadUrl(fileParam, kind);
}

export async function uploadMediaAsset(
  httpClient: HttpClient,
  kind: MediaKind,
  fileParam: FileInput,
  runtime: UploadRuntime,
  signal?: AbortSignal,
  assetDetails: { projectId?: string; name?: string } = {},
): Promise<string> {
  return runtime.run(
    (uploadSignal) =>
      rehostUpload(httpClient, fileParam, kind, runtime, uploadSignal, assetDetails),
    { signal },
  );
}

export async function resolveMedia(
  httpClient: HttpClient,
  kind: MediaKind,
  urlParam: string | undefined,
  assetIdParam: string | undefined,
  fileParam: MediaParam,
  runtime: UploadRuntime,
  signal?: AbortSignal,
): Promise<ResolvedMedia> {
  signal?.throwIfAborted();
  if (assetIdParam) return { type: kind, assetId: assetIdParam };

  // An explicit URL the model already holds (tts output, public/asset URL) wins.
  if (urlParam) return { type: kind, url: urlParam };

  assertValidFileParam(kind, fileParam);

  if (fileParam) {
    return {
      type: kind,
      assetId: await uploadMediaAsset(httpClient, kind, fileParam, runtime, signal),
    };
  }

  // Unreachable — callers validate presence first.
  throw new Error(`No ${kind} provided.`);
}
