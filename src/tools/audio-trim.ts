import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import { schemaProperty } from '../openapi/parser.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';

export function supportsAudioTrimming(operations: ParsedOperation[]): boolean {
  const create = operations.find((op) => op.method === 'post' && op.path === '/v2/audio-trims');
  return (
    !!create?.parameters.some(
      (p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key' && p.required,
    ) &&
    schemaProperty(create.requestBody?.schema ?? {}, 'assetId')?.format === 'uuid' &&
    !!operations.some((op) => op.method === 'get' && op.path === '/v2/audio-trims/{id}')
  );
}
const result = z.object({
  id: z.uuid(),
  status: z.enum(['queued', 'processing', 'completed', 'failed']),
  assetId: z.uuid().nullable(),
  durationSeconds: z.number().positive().nullable(),
  errorCode: z.string().nullable(),
  retryAfterMs: z.number().int().nonnegative(),
});

export function createAudioTrimTools(
  operations: ParsedOperation[],
  http: HttpClient,
): McpToolDefinition[] {
  if (!supportsAudioTrimming(operations)) return [];
  // assetId is the API's name for the source; audioAssetId is the older MCP name.
  const create = z
    .object({
      assetId: z.uuid().optional().describe('Saved AUDIO asset to shorten.'),
      projectId: z
        .uuid()
        .optional()
        .describe('Project to save the shortened audio in, from projects_create or projects_list.'),
      durationSeconds: z
        .number()
        .min(0.01)
        .max(3600)
        .describe('Seconds to keep from the start of the audio, up to 3600.'),
      idempotencyKey: z
        .uuid()
        .describe(
          'A new UUID saved before the call. Reuse it with identical input only to recover an uncertain response.',
        ),
      audioAssetId: z
        .uuid()
        .optional()
        .describe('Deprecated alias of assetId.')
        .meta({ deprecated: true }),
    })
    .strict();
  const read = z
    .object({ id: z.uuid().describe('Audio trim id from audio-trims_create.') })
    .strict();
  return [
    {
      name: 'audio-trims_create',
      title: 'Prepare shorter audio',
      description:
        'Save the first durationSeconds of an authorized Sync audio asset, passed as assetId, as a new reusable asset. Explain and confirm the partial duration first. Persist one idempotencyKey and reuse it with identical inputs after an uncertain response. This prepares audio only: it never generates video, spends generation credits, or consumes a free generation. Poll audio-trims_get until completed, then use its assetId and actual duration for a fresh quote. Partial video lipsync must use cut_off; keep the original draft unchanged. Failed operations require an explicit new attempt.',
      inputSchema: create.shape,
      outputSchema: result.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (args, context) => {
        const { assetId, audioAssetId, idempotencyKey, ...rest } = create.parse(args);
        const source = assetId ?? audioAssetId;
        if (source === undefined) throw new Error('Pass assetId.');
        if (assetId !== undefined && audioAssetId !== undefined && assetId !== audioAssetId)
          throw new Error('assetId and audioAssetId name different assets; pass assetId only.');
        return result.parse(
          await http.request('post', '/v2/audio-trims', {
            body: { ...rest, assetId: source },
            headers: { 'Idempotency-Key': idempotencyKey },
            signal: context?.signal,
          }),
        );
      },
    },
    {
      name: 'audio-trims_get',
      title: 'Read audio preparation',
      description:
        'Read one audio trim by id: its status (queued, processing, completed or failed), and once completed the assetId and durationSeconds of the shortened audio, or its errorCode. While it is queued or processing, call it again after retryAfterMs; never create another trim. Never starts video generation.',
      inputSchema: read.shape,
      outputSchema: result.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (args, context) =>
        result.parse(
          await http.request('get', `/v2/audio-trims/${read.parse(args).id}`, {
            signal: context?.signal,
          }),
        ),
    },
  ];
}
