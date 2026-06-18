import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

// A file as ChatGPT delivers it for an `openai/fileParams` field. Only
// download_url is needed to run the generation; the rest is metadata ChatGPT
// includes.
const fileInput = z.object({
  download_url: z.string(),
  file_id: z.string().optional(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

/**
 * Hand-written tools layered on top of the auto-generated ones.
 *
 * `create-lipsync` is a flat convenience wrapper over POST /v2/generate (the
 * auto-generated generate_create-generation takes a nested `input[]` array).
 *
 * Each media input can arrive two ways, and the URL form is primary:
 *  - `*Url` string — a hosted/public URL, e.g. the `url` returned by tts_create,
 *    or an asset URL. This is the reliable path and the only way to chain the
 *    output of another tool (the model can't put a URL into a fileParam field).
 *  - `video`/`image`/`audio` file objects — declared as `openai/fileParams` so
 *    ChatGPT can hand a user-uploaded file straight in. Native file handoff is
 *    host-dependent, so always prefer a URL when you have one.
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
          video?: { download_url?: string };
          image?: { download_url?: string };
          audio?: { download_url?: string };
          model?: string;
        };

        // URL wins; otherwise fall back to an uploaded file's download_url.
        const resolvedAudio = audioUrl ?? audio?.download_url;
        const resolvedVideo = videoUrl ?? video?.download_url;
        const resolvedImage = imageUrl ?? image?.download_url;

        if (!resolvedAudio) {
          throw new Error(
            'Audio is required — pass `audioUrl` (e.g. the url from tts_create) or upload an audio file.',
          );
        }
        if (!resolvedVideo && !resolvedImage) {
          throw new Error(
            'Provide a video or an image — pass `videoUrl`/`imageUrl` or upload a file.',
          );
        }
        if (resolvedVideo && resolvedImage) {
          throw new Error('Provide either a video or an image, not both.');
        }

        const visual = resolvedImage
          ? { type: 'image', url: resolvedImage }
          : { type: 'video', url: resolvedVideo };
        // Image-to-video is only supported by sync-3; default the model to match.
        const resolvedModel = model ?? (resolvedImage ? 'sync-3' : 'lipsync-2');

        return httpClient.request('post', '/v2/generate', {
          body: {
            model: resolvedModel,
            input: [visual, { type: 'audio', url: resolvedAudio }],
          },
        });
      },
    },
  ];
}
