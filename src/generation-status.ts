import type { ResourceMetadata, Tool } from '@modelcontextprotocol/server';
import type { SyncMcpConfig } from './config.js';
import { oldNameAliases } from './tool-names.js';
import type { McpToolDefinition } from './tools/generator.js';
import { MCP_APP_RESOURCE_MIME_TYPE } from './tools/upload-widget.js';

export const GENERATION_STATUS_URI = 'ui://sync/generation-status-v1.html';
const submissionTools = new Set([
  'lipsync_create',
  'lipsync_create-from-assets',
  'lipsync_create-timeline',
  'dubbing_create',
  'dialogue-videos_create',
  'generations_create',
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

/**
 * The card's own descriptor metadata, for clients that render only the card: the standard
 * MCP Apps resourceUri, without ChatGPT's openai/* keys or any other ui setting.
 */
export function statusCardMeta(meta: Record<string, unknown> | undefined) {
  const ui = meta?.ui as { resourceUri?: unknown } | undefined;
  return ui?.resourceUri === GENERATION_STATUS_URI
    ? { ui: { resourceUri: GENERATION_STATUS_URI } }
    : {};
}

/**
 * The card checks a generation through generations_get's previous name, and MCP Apps hosts
 * let a card call only listed tools that include app in ui.visibility. App profiles list
 * that name already (withLegacyAppDescriptors); a card-only client gets it here, app-only,
 * so the model never sees it. It goes when the old name's deprecation ends.
 */
export function withStatusCardTool(descriptors: Tool[]): Tool[] {
  const current = descriptors.find((descriptor) => descriptor.name === 'generations_get');
  if (!current) return descriptors;
  const listed = new Set(descriptors.map((descriptor) => descriptor.name));
  const meta = current._meta ?? {};
  const ui = (meta.ui ?? {}) as Record<string, unknown>;
  const legacy = oldNameAliases(current.name)
    .filter((name) => !listed.has(name))
    .map((name) => ({
      ...current,
      name,
      description: `Deprecated name of ${current.name}, kept for the Sync generation status card. Call ${current.name}.`,
      _meta: { ...meta, ui: { ...ui, visibility: ['app'] } },
    }));
  return [...descriptors, ...legacy];
}

const description =
  'This Sync generation: title, source thumbnail, summary, measured progress and estimated time remaining, with a read-only check status action and completed video playback.';
export function generationStatusMetadata(app: SyncMcpConfig['chatgptApp']): ResourceMetadata {
  const resourceDomains = [...(app?.resourceDomains ?? []), 'data:'];
  return {
    title: 'Sync generation status',
    description,
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains } },
      'openai/widgetDescription': description,
      'openai/widgetPrefersBorder': true,
      'openai/widgetCSP': { connect_domains: [], resource_domains: resourceDomains },
    },
  };
}
