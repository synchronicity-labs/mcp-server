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
      assetId: z
        .uuid()
        .optional()
        .describe(
          'Saved AUDIO asset to shorten, from assets_list or assets_create. Required in practice; audioAssetId is only its deprecated alias.',
        ),
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
    .object({
      id: z
        .uuid()
        .describe(
          'The id that audio-trims_create returned (a UUID). Poll with this same id until the trim is completed or failed.',
        ),
    })
    .strict();
  return [
    {
      name: 'audio-trims_create',
      title: 'Prepare shorter audio',
      description:
        'Save the first durationSeconds of an authorized audio asset (assetId) as a new, reusable audio asset. Use it only when audio is longer than a lipsync can take and only its beginning is needed. Not for a partial video lipsync: there, leave the original video and draft unchanged and set options.sync_mode to cut_off on lipsync_create.\n\nExplain and confirm the partial duration first. This prepares audio only: it never generates video, spends generation credits, or consumes a free generation. Persist one idempotencyKey before calling and reuse it with identical inputs only after an uncertain response. Failed operations require an explicit new attempt.\n\nReturns id and status (queued, processing, completed or failed) at once; assetId and durationSeconds stay null until completed, errorCode is set on failure, and retryAfterMs is the wait in milliseconds before the next read. Poll audio-trims_get until completed (jobs_get and jobs_wait do not read trims), then use its assetId and actual duration for a fresh quote.\n\nPass assetId, not its deprecated alias audioAssetId; the call fails when neither is given or the two name different assets. projectId saves the new asset in that project and needs projectIntent=explicit, which only an explicit user choice or a project just created for this request allows.',
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
        'Read one audio trim by the id audio-trims_create returned, to follow it until it ends; jobs_get and jobs_wait do not read audio trims. Returns its status; once completed, the assetId (the same value as this id) and actual durationSeconds of the new shortened audio asset, both null before; once failed, its errorCode; and retryAfterMs, the wait before the next read.\n\n' +
        'While it is queued or processing, call again after retryAfterMs milliseconds; never create another trim. When completed, use the new assetId and its actual duration in place of the original audio. If it failed, tell the user the errorCode; another trim needs an explicit new attempt with audio-trims_create. An API error returns {error: {message, status, code when given}} instead. It never starts video generation or spends credits.',
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
