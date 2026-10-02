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
      name: 'projects_get-generations',
      title: 'Read project history',
      description:
        'Read generation history for an accessible Sync project. Requires a projectId returned by projects_get-all. Pass limit and the last returned generation id as cursor to load another page. These are the same records used by the Sync web app.',
      inputSchema: {
        ...history.inputSchema,
        projectId: history.inputSchema.projectId!.nonoptional(),
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
