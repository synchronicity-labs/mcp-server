import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import { createGenerationContinuationTool } from './generation-continuation.js';

/** Optional for released clients: absence must preserve the original fingerprint. */
export const generationContextSchema = z
  .object({
    workflow: z.enum(['lipsync', 'translate_and_dub', 'image_to_video', 'edit_dialogue']),
    parentGenerationId: z.uuid(),
  })
  .strict();

export async function generationContextHeaders(
  http: HttpClient,
  args: Record<string, unknown>,
  workflows: readonly z.infer<typeof generationContextSchema>['workflow'][],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  if (args.continuation === undefined) return {};
  const context = generationContextSchema.parse(args.continuation);
  const projectId = z.uuid().parse(args.projectId);
  if (!workflows.includes(context.workflow))
    throw new Error('The continuation workflow does not match this action.');
  // The same Studio read validates the selected project, parent and source access.
  // Do not trust a parent UUID supplied by the embedded view as authorization.
  await createGenerationContinuationTool(http).handler(
    { projectId, id: context.parentGenerationId },
    { signal },
  );
  signal?.throwIfAborted();
  return {
    'x-sync-workflow': context.workflow,
    'x-sync-parent-generation-id': context.parentGenerationId,
  };
}
