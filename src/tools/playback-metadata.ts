import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

// Narrow read projection of the API's AssetMetadataSchema. Analysis, transcript,
// provider and face-detection fields never cross the app boundary.
const playbackMetadata = z.object({
  assetId: z.uuid(),
  duration: z.number().finite().nonnegative().nullish(),
  fps: z.number().finite().positive().nullish(),
  frameCount: z.number().int().nonnegative().nullish(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  codec: z.string().nullish(),
  format: z.string().nullish(),
  proxyPath: z.url().nullish(),
  proxyRequested: z.boolean().optional(),
  thumbnailsManifestUrl: z.url().nullish(),
});

export function createPlaybackMetadataTool(http: HttpClient): McpToolDefinition {
  const input = z
    .object({ assetId: z.uuid().describe('Asset id (UUID) from assets_list or assets_get.') })
    .strict();
  return {
    name: 'assets_get-playback-metadata',
    title: 'Read video playback metadata',
    description:
      "Read one asset's measured playback metadata: duration in seconds, fps, frameCount, width, height, codec, container format, proxyPath (a browser playback proxy), proxyRequested (a proxy was requested, so proxyPath may appear later) and thumbnailsManifestUrl. Use it to convert between seconds and frames for frame-accurate edits such as lipsync_create-timeline clips; use assets_get for the name and media url, and assets_get-download-url to download the file. Requires a signed-in user: with an API key it returns {supported: false, metadata: null}. metadata is null when nothing has been recorded for the asset, and a field it could not measure is null or omitted; treat those values as unknown and never guess them. It does not analyze media, read transcripts, or change the asset.",
    inputSchema: input.shape,
    outputSchema: { supported: z.boolean(), metadata: playbackMetadata.nullable() },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (args, context) => {
      const { assetId } = input.parse(args);
      const identity = z
        .object({ account: z.object({ id: z.uuid() }).nullable() })
        .parse(await http.request('get', '/v2/oauth/account', { signal: context?.signal }));
      if (!identity.account) return { supported: false, metadata: null };
      const rows = playbackMetadata
        .array()
        .max(1)
        .parse(
          await http.request('get', '/v2/asset-metadata/by-asset', {
            query: { assetId },
            signal: context?.signal,
          }),
        );
      const metadata = rows[0] ?? null;
      if (metadata && metadata.assetId !== assetId)
        throw new Error('Playback metadata does not match the requested asset.');
      return { supported: true, metadata };
    },
  };
}
