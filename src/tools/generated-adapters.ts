import { z } from 'zod';
import type { ApiRequestError, HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition, ToolRequestContext } from './generator.js';
import { isImportInProgress, jobSettled, rawStatus } from './job-status.js';
import { pollUntil, waitInput } from './job-wait.js';

/**
 * Agent-facing fixes for tools generated straight from the public OpenAPI spec. Each one
 * keeps accepting the generated input, so callers holding the old tool list still work.
 */

// Tools whose project is the target itself: the caller names the project to read or
// change, so the new-project intent guard (project-intent.ts) does not apply to them.
export const projectTargetTools = new WeakSet<McpToolDefinition>();

const PROJECT_PATH = /^\/v2\/projects\/\{id\}(?:\/|$)/;
const IMPORT_RETRY_MS = 15_000;

type JsonTool = Exclude<McpToolDefinition, { resultFormat: 'mcp' }>;

/** Every other tool calls the project `projectId`; generated project routes said `id`. */
function withProjectIdAlias(tool: JsonTool): JsonTool {
  const { id, ...rest } = tool.inputSchema;
  if (!id) return tool;
  const handler = tool.handler;
  const adapted: JsonTool = {
    ...tool,
    inputSchema: {
      projectId: z.string().optional().describe('Project ID (UUID).'),
      ...rest,
      id: z.string().optional().describe('Deprecated alias of projectId.'),
    },
    handler: async (args, context) => {
      const { projectId, id: alias, ...fields } = args;
      const project = projectId ?? alias;
      if (project === undefined) throw new Error('Pass projectId.');
      if (alias !== undefined && projectId !== undefined && alias !== projectId)
        throw new Error('projectId and id name different projects; pass projectId only.');
      const result = await handler({ ...fields, id: project }, context);
      if (result !== '') return result;
      // 204 responses: say what happened instead of an empty string.
      return tool.name === 'projects_attach-asset'
        ? { projectId: project, assetId: fields.assetId, attached: true }
        : { projectId: project, ok: true };
    },
  };
  projectTargetTools.add(adapted);
  return adapted;
}

/** Transcription takes source URLs; every other workflow passes saved assets by id. */
function withTranscriptionAsset(tool: JsonTool, http: HttpClient): JsonTool {
  const handler = tool.handler;
  return {
    ...tool,
    description: `${tool.description} Pass assetId to transcribe a saved VIDEO or AUDIO asset instead of a source URL.`,
    inputSchema: {
      ...tool.inputSchema,
      // An assetId replaces the source URL, so neither can stay required.
      ...Object.fromEntries(
        (['sourceVideoUrl', 'sourceAudioUrl'] as const)
          .filter((key) => tool.inputSchema[key])
          .map((key) => [key, tool.inputSchema[key]!.optional()]),
      ),
      assetId: z
        .uuid()
        .optional()
        .describe(
          'Saved VIDEO or AUDIO asset to transcribe; replaces sourceVideoUrl/sourceAudioUrl.',
        ),
    },
    handler: async (args, context) => {
      const { assetId: rawAssetId, ...fields } = args;
      const assetId = z.uuid().optional().parse(rawAssetId);
      if (assetId === undefined) return handler(fields, context);
      if (fields.sourceVideoUrl !== undefined || fields.sourceAudioUrl !== undefined)
        throw new Error('Pass assetId or a source URL, not both.');
      const asset = z.object({ type: z.string(), url: z.string().min(1) }).parse(
        await http.request('get', `/v2/assets/${assetId}`, {
          signal: context?.signal,
        }),
      );
      if (asset.type !== 'VIDEO' && asset.type !== 'AUDIO')
        throw new Error(`Asset ${assetId} is ${asset.type}; transcribe a VIDEO or AUDIO asset.`);
      const source = asset.type === 'VIDEO' ? 'sourceVideoUrl' : 'sourceAudioUrl';
      return handler({ ...fields, [source]: asset.url }, context);
    },
  };
}

function withJobWait(tool: JsonTool, label: string): JsonTool {
  const handler = tool.handler;
  return {
    ...tool,
    description: `${tool.description} Pass wait: true to wait for the job on the server.`,
    inputSchema: { ...tool.inputSchema, wait: waitInput },
    handler: async ({ wait, ...args }, context) => {
      const read = (signal = context?.signal) => handler(args, { ...context, signal });
      if (wait !== true) return read();
      return pollUntil(read, jobSettled, context, {
        describe: (job) => `${label} ${String(rawStatus(job) ?? 'pending').toLowerCase()}`,
      });
    },
  };
}

/**
 * The API holds one generation read for at most 10 seconds (its timeout input, 1-10,
 * default 5), so waiting out an 11-minute dub took about 90 calls, more than a chat turn
 * allows. With wait: true, keep reading on the server like jobs_wait: each read still
 * long-polls the API, and the call returns once the generation settles or about 50
 * seconds pass. The generated input is unchanged, so every earlier call still works.
 */
function withGenerationWait(tool: JsonTool): JsonTool {
  const handler = tool.handler;
  return {
    ...tool,
    handler: async (args, context) => {
      if (args.wait !== true) return handler(args, context);
      const read = (signal = context?.signal) => handler(args, { ...context, signal });
      return pollUntil(read, jobSettled, context, {
        describe: (job) => `generation ${String(rawStatus(job) ?? 'pending').toLowerCase()}`,
      });
    },
  };
}

/** One import attempt: the saved asset, or the 409 that says it is still downloading. */
type ImportAttempt = { asset: unknown } | { pending: ApiRequestError };

export async function attemptImport(
  handler: JsonTool['handler'],
  args: Record<string, unknown>,
  context: ToolRequestContext | undefined,
  signal = context?.signal,
): Promise<ImportAttempt> {
  try {
    return { asset: await handler(args, { ...context, signal }) };
  } catch (error) {
    if (isImportInProgress(error)) return { pending: error };
    throw error;
  }
}

export const importWaitOptions = {
  describe: (attempt: ImportAttempt) => {
    const progress = 'pending' in attempt ? attempt.pending.importDetails?.progress : undefined;
    return `importing${progress === undefined ? '' : ` ${progress}%`}`;
  },
  delayMs: (attempt: ImportAttempt) =>
    'pending' in attempt ? (attempt.pending.retryAfterMs ?? IMPORT_RETRY_MS) : undefined,
};

/** A social import answers 409 import_in_progress until the asset is saved. */
function withImportWait(tool: JsonTool): JsonTool {
  const handler = tool.handler;
  return {
    ...tool,
    description: `${tool.description} For a social link, pass wait: true to wait for the import on the server; a 409 import_in_progress then only means it is still downloading after about 50 seconds, so call again with the same input.`,
    inputSchema: { ...tool.inputSchema, wait: waitInput },
    handler: async ({ wait, ...args }, context) => {
      if (wait !== true) return handler(args, context);
      const last = await pollUntil(
        (signal) => attemptImport(handler, args, context, signal),
        (attempt) => 'asset' in attempt,
        context,
        importWaitOptions,
      );
      if ('pending' in last) throw last.pending;
      return last.asset;
    },
  };
}

export function adaptGeneratedTool(
  tool: McpToolDefinition,
  operation: ParsedOperation | undefined,
  http: HttpClient,
): McpToolDefinition {
  if (tool.resultFormat === 'mcp' || !operation) return tool;
  if (PROJECT_PATH.test(operation.path)) return withProjectIdAlias(tool);
  if (operation.method === 'post' && operation.path === '/v2/transcriptions')
    return withTranscriptionAsset(tool, http);
  if (operation.method === 'get' && operation.path === '/v2/transcriptions/{id}')
    return withJobWait(tool, 'transcription');
  if (operation.method === 'get' && operation.path === '/v2/transcriptions/{id}/speaker-analysis')
    return withJobWait(tool, 'speaker analysis');
  if (operation.method === 'post' && operation.path === '/v2/assets') return withImportWait(tool);
  if (operation.method === 'get' && operation.path === '/v2/generate/{id}')
    return withGenerationWait(tool);
  return tool;
}
