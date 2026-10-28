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
  const create = z
    .object({
      audioAssetId: z.uuid(),
      projectId: z.uuid().optional(),
      durationSeconds: z.number().min(0.01).max(3600),
      idempotencyKey: z.uuid(),
    })
    .strict();
  const read = z.object({ id: z.uuid() }).strict();
  return [
    {
      name: 'trim-audio',
      title: 'Prepare shorter audio',
      description:
        'Save the first durationSeconds of authorized Sync audio as a new reusable asset. Explain and confirm the partial duration first. Persist one idempotencyKey and reuse it with identical inputs after an uncertain response. This prepares audio only: it never generates video, spends generation credits, or consumes a free generation. Poll get-audio-trim until completed, then use its assetId and actual duration for a fresh quote. Partial video lipsync must use cut_off; keep the original draft unchanged. Failed operations require an explicit new attempt.',
      inputSchema: create.shape,
      outputSchema: result.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (args, context) => {
        const { audioAssetId, idempotencyKey, ...rest } = create.parse(args);
        return result.parse(
          await http.request('post', '/v2/audio-trims', {
            body: { ...rest, assetId: audioAssetId },
            headers: { 'Idempotency-Key': idempotencyKey },
            signal: context?.signal,
          }),
        );
      },
    },
    {
      name: 'get-audio-trim',
      title: 'Read audio preparation',
      description:
        'Read the same authorized audio preparation. Pending status is resumable; do not create another trim. This never starts video generation.',
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
