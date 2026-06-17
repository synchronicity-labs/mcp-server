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
        'Create a lipsync video from a video and an audio file. Drop a video + audio into the chat (or pass their URLs) and Sync syncs the lips to the audio. Returns a generation id — poll generate_get-generation until status is COMPLETED, then read outputUrl. For URL/assetId inputs or advanced options (segments, speaker selection, models other than lipsync), use generate_create-generation.',
      inputSchema: {
        video: fileInput,
        audio: fileInput,
        model: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      meta: {
        'openai/fileParams': ['video', 'audio'],
        'openai/toolInvocation/invoking': 'Creating your lipsync video…',
        'openai/toolInvocation/invoked': 'Lipsync generation started.',
      },
      handler: async (args) => {
        const { video, audio, model } = args as {
          video?: { download_url?: string };
          audio?: { download_url?: string };
          model?: string;
        };
        const videoUrl = video?.download_url;
        const audioUrl = audio?.download_url;
        if (!videoUrl || !audioUrl) {
          throw new Error(
            'Both a video and an audio file are required (each as an uploaded file or { download_url }).',
          );
        }
        return httpClient.request('post', '/v2/generate', {
          body: {
            model: model ?? 'lipsync-2',
            input: [
              { type: 'video', url: videoUrl },
              { type: 'audio', url: audioUrl },
            ],
          },
        });
      },
    },
  ];
}
