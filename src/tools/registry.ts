import type { McpToolDefinition } from './generator.js';

export type ToolRegistry = {
  list: () => McpToolDefinition[];
  get: (name: string) => McpToolDefinition | undefined;
  search: (query: string) => McpToolDefinition[];
};

export function createToolRegistry(tools: McpToolDefinition[]): ToolRegistry {
  const toolMap = new Map<string, McpToolDefinition>();
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  return {
    list() {
      return [...toolMap.values()];
    },

    get(name: string) {
      return toolMap.get(name);
    },

    search(query: string) {
      const lower = query.toLowerCase();
      return [...toolMap.values()].filter(
        (t) => t.name.toLowerCase().includes(lower) || t.description.toLowerCase().includes(lower),
      );
    },
  };
}
