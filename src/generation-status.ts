import type { ResourceMetadata } from '@modelcontextprotocol/server';
import type { McpToolDefinition } from './tools/generator.js';
import { MCP_APP_RESOURCE_MIME_TYPE } from './tools/upload-widget.js';

export const GENERATION_STATUS_URI = 'ui://sync/generation-status-v1.html';
const submissionTools = new Set([
  'create-lipsync',
  'create-lipsync-from-assets',
  'create-translate-and-dub',
  'create-dialogue-video',
  'generate_create-generation',
]);

export function withGenerationStatusCard(tool: McpToolDefinition): McpToolDefinition {
  if (!submissionTools.has(tool.name)) return tool;
  return {
    ...tool,
    meta: {
      ...tool.meta,
      ui: {
        ...(tool.meta?.ui as Record<string, unknown> | undefined),
        resourceUri: GENERATION_STATUS_URI,
      },
      'openai/outputTemplate': GENERATION_STATUS_URI,
    },
  };
}

const description =
  'Status of this Sync generation, with estimated time remaining and a read-only Check status action.';
export const GENERATION_STATUS_METADATA: ResourceMetadata = {
  title: 'Sync generation status',
  description,
  mimeType: MCP_APP_RESOURCE_MIME_TYPE,
  _meta: {
    ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: ['data:'] } },
    'openai/widgetDescription': description,
    'openai/widgetPrefersBorder': true,
    'openai/widgetCSP': { connect_domains: [], resource_domains: ['data:'] },
  },
};
