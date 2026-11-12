import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

const text = z.string().trim().min(1).max(256);
const mediaUrl = z.url({ protocol: /^https$/ });
export const generationDisplaySchema = z.object({
  title: text.optional(),
  thumbnailUrl: mediaUrl.optional(),
  durationSeconds: z.number().finite().nonnegative().optional(),
  sourceLang: text.nullish(),
  targetLang: text.optional(),
});
export const generationCardProgressSchema = z.object({
  stage: z.enum(['queued', 'processing', 'completed', 'failed']).optional(),
  percent: z.number().finite().min(0).max(100).optional(),
  completedTasks: z.number().int().nonnegative().optional(),
  runningTasks: z.number().int().nonnegative().optional(),
  waitingTasks: z.number().int().nonnegative().optional(),
});
const source = z.object({ type: z.string(), assetId: z.uuid().optional() });
const resultSchema = z.object({
  id: z.string(),
  projectId: z.uuid().nullish(),
  outputFileName: text.nullish().catch(undefined),
  input: z.array(source).optional().catch(undefined),
});
const projectSchema = z.object({ id: z.uuid(), name: text });
const assetSchema = z.object({
  id: z.uuid(),
  name: text.optional(),
  thumbnailUrl: mediaUrl.nullish().catch(undefined),
  durationSeconds: z.number().finite().nonnegative().nullish().catch(undefined),
});
const dubbingSchema = z.object({
  dubbing: z.object({ sourceLang: text.nullable(), targetLang: text }).nullable(),
});

/** Only enrich explicit progress reads; normal agent waits keep their existing cost. */
export function withGenerationCardDetails(
  tool: McpToolDefinition,
  http: HttpClient,
): McpToolDefinition {
  if (tool.resultFormat === 'mcp') return tool;
  const submission = tool.meta?.['openai/outputTemplate'] === 'ui://sync/generation-status-v1.html';
  if (!submission && tool.name !== 'generations_get') return tool;
  const handler = tool.handler;
  return {
    ...tool,
    handler: async (args, context) => {
      const result = await handler(args, context);
      const parsed = resultSchema.safeParse(result);
      if (!parsed.success) return result;
      const display = submission
        ? generationDisplaySchema.safeParse({
            title: text.optional().catch(undefined).parse(args.projectName),
            ...(tool.name === 'dubbing_create'
              ? { sourceLang: args.sourceLang ?? 'auto', targetLang: args.targetLang }
              : {}),
          }).data
        : args.include === 'progress' ||
            (Array.isArray(args.include) && args.include.includes('progress'))
          ? await readDisplay(http, parsed.data, context?.signal)
          : undefined;
      const raw = result as Record<string, unknown>;
      return {
        ...raw,
        ...(display ? { display } : {}),
        ...('progress' in raw
          ? { progress: generationCardProgressSchema.safeParse(raw.progress).data }
          : {}),
      };
    },
  };
}

async function readDisplay(
  http: HttpClient,
  generation: z.infer<typeof resultSchema>,
  parentSignal?: AbortSignal,
): Promise<z.infer<typeof generationDisplaySchema>> {
  // Context is optional. Bound it separately so an unavailable project/asset never
  // turns a successful status read into a failed job or delays it for a minute.
  const timeout = AbortSignal.timeout(1500);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const read = async (path: string) => {
    try {
      return await http.request('get', path, { signal });
    } catch {
      return undefined;
    }
  };
  const visual = generation.input?.find(
    (input) => input.type === 'video' || input.type === 'image',
  );
  const [projectResult, assetResult, dubResult] = await Promise.all([
    generation.projectId ? read(`/v2/projects/${generation.projectId}`) : undefined,
    visual?.assetId ? read(`/v2/assets/${visual.assetId}`) : undefined,
    read(`/v2/generations/${encodeURIComponent(generation.id)}/dubbing`),
  ]);
  const project = projectSchema.safeParse(projectResult).data;
  const asset = assetSchema.safeParse(assetResult).data;
  const dub = dubbingSchema.safeParse(dubResult).data?.dubbing;
  const authorizedAsset = asset?.id === visual?.assetId ? asset : undefined;
  return {
    title:
      project?.id === generation.projectId
        ? project?.name
        : (generation.outputFileName ?? authorizedAsset?.name),
    ...(authorizedAsset?.thumbnailUrl ? { thumbnailUrl: authorizedAsset.thumbnailUrl } : {}),
    ...(authorizedAsset?.durationSeconds != null
      ? { durationSeconds: authorizedAsset.durationSeconds }
      : {}),
    ...(dub ? { sourceLang: dub.sourceLang, targetLang: dub.targetLang } : {}),
  };
}
