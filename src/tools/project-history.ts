import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import { generateTools, type McpToolDefinition } from './generator.js';

export function projectHistoryOperations(operations: ParsedOperation[]): ParsedOperation[] {
  const history = operations.find(
    (operation) =>
      operation.operationId === 'GenerateController_getGenerations' &&
      operation.method === 'get' &&
      operation.parameters.some(
        (parameter) => parameter.in === 'query' && parameter.name === 'projectId',
      ),
  );
  const project = operations.find(
    (operation) => operation.operationId === 'ProjectsController_get' && operation.method === 'get',
  );
  return history && project ? [history, project] : [];
}

export function createProjectHistoryTools(
  operations: ParsedOperation[],
  httpClient: HttpClient,
): McpToolDefinition[] {
  const [history, project] = generateTools(projectHistoryOperations(operations), httpClient);
  if (!history || !project) return [];

  return [
    {
      name: 'projects_list-generations',
      title: 'Read project history',
      description:
        "List the generations in one sync. project you can access, after first checking your access to that project. Use it for a project's history; for the whole organization, or without a projectId, use generations_list, and for one generation whose id you have use generations_get. A missing or inaccessible project fails with an error instead of returning an empty list. Always pass limit to get newest first; without it every generation in the project comes back unpaged in no guaranteed order. For the next page pass the last returned id as cursor with the same limit. Each entry has id, status, model, createdAt, projectId, input, options, outputMediaUrl once COMPLETED (outputUrl is a deprecated alias with the same value), and error and errorCode on failure.",
      inputSchema: {
        ...history.inputSchema,
        ...(history.inputSchema.status && {
          status: history.inputSchema.status.describe(
            'Only generations in this status: PENDING, PROCESSING, COMPLETED, FAILED or REJECTED.',
          ),
        }),
        projectId: history.inputSchema
          .projectId!.nonoptional()
          .describe('Project whose history to read (UUID), from projects_list or projects_create.'),
      },
      annotations: history.annotations,
      handler: async (args, context) => {
        // Check access independently before a read that an old API instance may
        // treat as an organization feed during a rolling deployment.
        const selected = await project.handler({ id: args.projectId }, context);
        if (
          !selected ||
          typeof selected !== 'object' ||
          !('id' in selected) ||
          selected.id !== args.projectId
        ) {
          throw new Error('Sync could not verify access to this project. Refresh and try again.');
        }
        const result = await history.handler(args, context);
        if (
          !Array.isArray(result) ||
          result.some(
            (item: unknown) =>
              !item ||
              typeof item !== 'object' ||
              !('projectId' in item) ||
              item.projectId !== args.projectId,
          )
        ) {
          throw new Error(
            'Project history is temporarily unavailable. Sync did not return history scoped to this project.',
          );
        }
        return result;
      },
    },
  ];
}
