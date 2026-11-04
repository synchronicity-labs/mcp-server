import type { McpToolDefinition } from './generator.js';

/**
 * The API names a generation's result `outputMediaUrl` (GenerationDto), while /v2/generate
 * returns `outputUrl`. Generation results carry both names with one value, so callers that
 * read either keep working; `outputUrl` stays as a deprecated alias.
 */
type Alias = readonly [apiName: string, legacyName: string];

const RESULT_URL: Alias = ['outputMediaUrl', 'outputUrl'];
const DURATION: Alias = ['outputMediaLength', 'outputDuration'];
// Raw generation lists from GET /v2/generations, without an output schema.
const GENERATION_LIST_TOOLS = new Set(['generate_get-generations', 'projects_get-generations']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withAliases(value: unknown, aliases: readonly Alias[] = [RESULT_URL]): unknown {
  if (!isRecord(value)) return value;
  const result = { ...value };
  for (const [apiName, legacyName] of aliases) {
    if (!(apiName in value) && !(legacyName in value)) continue;
    const field = apiName in value ? value[apiName] : value[legacyName];
    result[apiName] = field;
    result[legacyName] = field;
  }
  return result;
}

export function withGenerationOutputAliases(tool: McpToolDefinition): McpToolDefinition {
  if (tool.resultFormat === 'mcp') return tool;
  const schema = tool.outputSchema;
  const list = GENERATION_LIST_TOOLS.has(tool.name);
  if (!list && !(schema && 'outputMediaUrl' in schema && 'outputUrl' in schema)) return tool;
  const aliases = schema && 'outputMediaLength' in schema ? [RESULT_URL, DURATION] : [RESULT_URL];
  const handler = tool.handler;
  return {
    ...tool,
    handler: async (args, context) => {
      const result = await handler(args, context);
      return list && Array.isArray(result)
        ? result.map((item) => withAliases(item))
        : withAliases(result, aliases);
    },
  };
}
