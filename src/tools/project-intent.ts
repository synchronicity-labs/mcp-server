import { z } from 'zod';
import { ApiRequestError } from '../http-client.js';
import type { McpToolDefinition, ToolRequestContext } from './generator.js';

export function withProjectIntent(tool: McpToolDefinition): McpToolDefinition {
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
    if (fields.projectId !== undefined && projectIntent !== 'explicit')
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
