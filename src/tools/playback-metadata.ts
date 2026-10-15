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
  const input = z.object({ assetId: z.uuid() }).strict();
  return {
    name: 'get-playback-metadata',
    title: 'Read video playback metadata',
    description:
      'Read timing, frame rate, dimensions and playback proxy metadata for an accessible Sync asset. Requires a connected user; API keys return unsupported. Missing metadata stays unknown. Does not analyze media, read transcripts, or modify assets.',
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
