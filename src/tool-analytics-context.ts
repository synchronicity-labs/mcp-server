import { AsyncLocalStorage } from 'node:async_hooks';

/** Who started the current tool call, forwarded with its API requests. */
export type ToolAttribution = {
  version: 1;
  invocation_source: 'model' | 'ui' | 'background' | 'unknown';
  journey_id?: string;
  action_id?: string;
  conversation_id?: string;
};

const context = new AsyncLocalStorage<ToolAttribution>();

export function getToolAnalytics(): ToolAttribution | undefined {
  return context.getStore();
}

export function runWithToolAnalytics<T>(attribution: ToolAttribution, run: () => T): T {
  return context.run(attribution, run);
}
