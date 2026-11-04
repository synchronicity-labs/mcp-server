import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';
import { pollUntil, sleep, WAIT_BUDGET_MS, waitInput } from './job-wait.js';

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
  const status = (job: unknown) =>
    z.object({ status: z.string() }).safeParse(job).data?.status.toUpperCase();
  return {
    ...tool,
    description: `${tool.description} Pass wait: true to wait for the job on the server.`,
    inputSchema: { ...tool.inputSchema, wait: waitInput },
    handler: async ({ wait, ...args }, context) => {
      const read = () => handler(args, context);
      if (wait !== true) return read();
      return pollUntil(
        read,
        (job) =>
          ['COMPLETED', 'FAILED', 'CANCELED', 'CANCELLED'].includes(status(job) ?? 'COMPLETED'),
        context,
        {
          describe: (job) => `${label} ${(status(job) ?? 'pending').toLowerCase()}`,
        },
      );
    },
  };
}

/** A social import answers 409 import_in_progress until the asset is saved. */
function withImportWait(tool: JsonTool): JsonTool {
  const handler = tool.handler;
  return {
    ...tool,
    description: `${tool.description} For a social link, pass wait: true to wait for the import on the server; a 409 import_in_progress then only means it is still downloading after about 50 seconds, so call again with the same input.`,
    inputSchema: { ...tool.inputSchema, wait: waitInput },
    handler: async ({ wait, ...args }, context) => {
      const deadline = Date.now() + WAIT_BUDGET_MS;
      for (let attempt = 1; ; attempt++) {
        try {
          return await handler(args, context);
        } catch (error) {
          const importing =
            error instanceof ApiRequestError &&
            error.status === 409 &&
            error.code === 'import_in_progress';
          const pause =
            error instanceof ApiRequestError ? (error.retryAfterMs ?? IMPORT_RETRY_MS) : 0;
          if (wait !== true || !importing || Date.now() + pause > deadline) throw error;
          const progress = error.importDetails?.progress;
          await context?.progress?.(
            attempt,
            `importing${progress === undefined ? '' : ` ${progress}%`}`,
          );
          await sleep(pause, context?.signal);
        }
      }
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
  if (operation.method === 'post' && operation.path === '/v2/assets') return withImportWait(tool);
  return tool;
}
