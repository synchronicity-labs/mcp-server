import { z } from 'zod';
import type { HttpClient } from '../http-client.js';

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
  // Authorize the lineage headers without reading the parent's media/settings.
  // Unrelated deleted sources must not block the API's same-key replay. The API
  // authorizes the submitted inputs on new admission; continuation reads still
  // check source access before returning media to the embedded view.
  const project = z
    .object({ id: z.uuid() })
    .parse(await http.request('get', `/v2/projects/${projectId}`, { signal }));
  if (project.id !== projectId) throw new Error('Could not verify project access.');
  const page = z
    .object({ items: z.array(z.object({ id: z.uuid(), projectId: z.uuid() })).length(1) })
    .parse(
      await http.request('get', '/v2/generations/list', {
        query: { projectId, ids: context.parentGenerationId, limit: '1' },
        signal,
      }),
    );
  const parent = page.items[0]!;
  if (parent.id !== context.parentGenerationId || parent.projectId !== projectId)
    throw new Error('The generation does not belong to this project.');
  signal?.throwIfAborted();
  return {
    'x-sync-workflow': context.workflow,
    'x-sync-parent-generation-id': context.parentGenerationId,
  };
}
