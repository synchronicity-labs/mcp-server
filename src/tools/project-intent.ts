import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import type { McpToolDefinition, ToolRequestContext } from './generator.js';

// A project this new with no generations can only be the one created for this request,
// which clients holding a tool list from before projectIntent existed pass without it.
const FRESH_PROJECT_MS = 30 * 60_000;
const freshProjectSchema = z.object({
  createdAt: z.string(),
  generations: z.array(z.unknown()).length(0),
});

async function isFreshEmptyProject(
  http: HttpClient,
  projectId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const project = freshProjectSchema.safeParse(
      await http.request('get', `/v2/projects/${encodeURIComponent(projectId)}`, { signal }),
    );
    if (!project.success) return false;
    const age = Date.now() - Date.parse(project.data.createdAt);
    return age >= 0 && age <= FRESH_PROJECT_MS;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

export function withProjectIntent(tool: McpToolDefinition, http: HttpClient): McpToolDefinition {
  if (!('projectId' in tool.inputSchema) || tool.annotations?.readOnlyHint) return tool;
  const ui = tool.meta?.ui as { visibility?: string[] } | undefined;
  if (ui?.visibility?.length === 1 && ui.visibility[0] === 'app') return tool;
  const definition = {
    ...tool,
    description:
      tool.description +
      ' When supplying projectId, projectIntent=explicit is required: the user must explicitly ask to work in that project, select it in the interface, or this must be the project just created for this request. A matching workflow/name or an already-open editor is never permission to modify it. Default new work to a new project.',
    inputSchema: {
      ...tool.inputSchema,
      projectIntent: z
        .literal('explicit')
        .optional()
        .describe(
          'Required with projectId. Set only for an explicit user project selection/update, or the new project just created for this request. Never infer intent from a matching project name, workflow name or active editor.',
        ),
    },
  };
  const input = async (args: Record<string, unknown>, signal?: AbortSignal) => {
    const { projectIntent, ...fields } = args;
    if (
      typeof fields.projectId === 'string' &&
      projectIntent !== 'explicit' &&
      !(await isFreshEmptyProject(http, fields.projectId, signal))
    )
      throw new ApiRequestError(
        'Existing project use requires an explicit user selection. Create a new project for a new workflow request; do not reuse a matching name or the active editor.',
        400,
        'PROJECT_INTENT_REQUIRED',
      );
    return fields;
  };
  return tool.resultFormat === 'mcp'
    ? {
        ...definition,
        resultFormat: 'mcp',
        handler: async (args: Record<string, unknown>, context?: ToolRequestContext) =>
          tool.handler(await input(args, context?.signal), context),
      }
    : {
        ...definition,
        resultFormat: 'json',
        handler: async (args: Record<string, unknown>, context?: ToolRequestContext) =>
          tool.handler(await input(args, context?.signal), context),
      };
}
