import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

// A file as ChatGPT delivers it for an `openai/fileParams` field. Only
// download_url is needed to run the generation; the rest is metadata ChatGPT
// includes. Non-uploading clients can pass `{ download_url: "https://..." }`.
const fileInput = z.object({
  download_url: z.string(),
  file_id: z.string().optional(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

/**
 * Hand-written tools layered on top of the auto-generated ones.
 *
 * `create-lipsync` exposes a flat, file-friendly shape so ChatGPT can hand
 * user-uploaded files straight in via `openai/fileParams` — the auto-generated
 * generate_create-generation tool takes a nested `input[]` array, which
 * fileParams cannot populate (it only targets top-level fields). This is purely
 * an ergonomics layer: it forwards the file download URLs to the same
 * POST /v2/generate. URLs work for any client that does not upload files.
 */
export function createAppTools(httpClient: HttpClient): McpToolDefinition[] {
  return [
    {
      name: 'create-lipsync',
      description:
        'Create a lipsync video from an audio file plus EITHER a video or a still image (an image drives sync-3 image-to-video). Drop the files into the chat (or pass their URLs) and Sync syncs the lips to the audio. Provide exactly one of `video` or `image`. Returns a generation id — poll generate_get-generation until status is COMPLETED, then read outputUrl. For assetId inputs or advanced options (segments, speaker selection), use generate_create-generation.',
      inputSchema: {
        video: fileInput.optional(),
        image: fileInput.optional(),
        audio: fileInput,
        model: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      meta: {
        'openai/fileParams': ['video', 'image', 'audio'],
        'openai/toolInvocation/invoking': 'Creating your lipsync video…',
        'openai/toolInvocation/invoked': 'Lipsync generation started.',
      },
      handler: async (args) => {
        const { video, image, audio, model } = args as {
          video?: { download_url?: string };
          image?: { download_url?: string };
          audio?: { download_url?: string };
          model?: string;
        };
        const audioUrl = audio?.download_url;
        const videoUrl = video?.download_url;
        const imageUrl = image?.download_url;
        if (!audioUrl) {
          throw new Error('An audio file is required (an uploaded file or { download_url }).');
        }
        if (!videoUrl && !imageUrl) {
          throw new Error('Provide a video or an image (an uploaded file or { download_url }).');
        }
        if (videoUrl && imageUrl) {
          throw new Error('Provide either a video or an image, not both.');
        }
        const visual = imageUrl
          ? { type: 'image', url: imageUrl }
          : { type: 'video', url: videoUrl };
        // Image-to-video is only supported by sync-3; default the model to match.
        const resolvedModel = model ?? (imageUrl ? 'sync-3' : 'lipsync-2');
        return httpClient.request('post', '/v2/generate', {
          body: {
            model: resolvedModel,
            input: [visual, { type: 'audio', url: audioUrl }],
          },
        });
      },
    },
  ];
}
