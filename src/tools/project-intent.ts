import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getAuthToken } from '../auth/async-context.js';
import { ApiRequestError } from '../http-client.js';
import type { McpToolDefinition, ToolRequestContext } from './generator.js';

// Clients holding a tool list from before projectIntent existed create a project, then
// pass its id without projectIntent. Accept only projects this connection just created.
const CREATED_PROJECT_TTL_MS = 30 * 60_000;
const createdProjects = new Map<string, number>();

function createdProjectKey(projectId: string): string {
  const credential = createHash('sha256')
    .update(getAuthToken() ?? '')
    .digest('hex');
  return `${credential}\0${projectId}`;
}

function rememberCreatedProject(result: unknown): void {
  const project = z.object({ id: z.string().min(1) }).safeParse(result);
  if (!project.success) return;
  const now = Date.now();
  for (const [key, expires] of createdProjects) if (expires <= now) createdProjects.delete(key);
  createdProjects.set(createdProjectKey(project.data.id), now + CREATED_PROJECT_TTL_MS);
}

function createdHere(projectId: string): boolean {
  return (createdProjects.get(createdProjectKey(projectId)) ?? 0) > Date.now();
}

export function withProjectIntent(tool: McpToolDefinition): McpToolDefinition {
  if (tool.name === 'projects_create' && tool.resultFormat !== 'mcp')
    return {
      ...tool,
      handler: async (args: Record<string, unknown>, context?: ToolRequestContext) => {
        const result = await tool.handler(args, context);
        rememberCreatedProject(result);
        return result;
      },
    };
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
  const input = (args: Record<string, unknown>) => {
    const { projectIntent, ...fields } = args;
    if (
      fields.projectId !== undefined &&
      projectIntent !== 'explicit' &&
      !(typeof fields.projectId === 'string' && createdHere(fields.projectId))
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
        handler: (args: Record<string, unknown>, context?: ToolRequestContext) =>
          tool.handler(input(args), context),
      }
    : {
        ...definition,
        resultFormat: 'json',
        handler: (args: Record<string, unknown>, context?: ToolRequestContext) =>
          tool.handler(input(args), context),
      };
}
