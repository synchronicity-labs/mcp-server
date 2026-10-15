import { z } from 'zod';
import type { ClientProfile } from './client-profile.js';
import type { McpToolDefinition } from './tools/generator.js';

const WIDGET_CALLABLE_HOSTED_TOOLS = new Set([
  'get-account-context',
  'get-dialogue-options',
  'create-dialogue-transcription',
  'get-dialogue-transcription',
  'create-dialogue-preview',
  'get-dialogue-preview',
  'estimate-dialogue-video',
  'create-dialogue-video',
  'upload-media',
  'create-lipsync',
  'create-lipsync-from-assets',
  'create-translate-and-dub',
  'get-translation-options',
  'voices_get-voices',
  'generate_get-generation',
  'models_get',
  'projects_get-all',
  'projects_get',
  'assets_get-all',
  'assets_get',
  'assets_create-upload-url',
  'assets_create',
  'projects_create',
  'generate_get-generations',
  'projects_get-generations',
  'generate_estimate-cost',
]);
const UPLOAD_CARD_TOOLS = new Set([
  'get-account-context',
  'assets_create-upload-url',
  'assets_create',
  'assets_get',
  'open-media-upload',
]);

function exposeToolToWidget(tool: McpToolDefinition, openai = true): McpToolDefinition {
  const meta = tool.meta ?? {};
  const ui = asRecord(meta.ui);
  return {
    ...tool,
    meta: {
      ...meta,
      ui: {
        ...ui,
        visibility: ui.visibility ?? ['model', 'app'],
      },
      ...(openai ? { 'openai/widgetAccessible': true } : {}),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Profile-specific descriptors and presentation. Authentication remains request-scoped. */
export function presentTool(tool: McpToolDefinition, profile: ClientProfile): McpToolDefinition {
  if (profile.supportsUploads)
    return WIDGET_CALLABLE_HOSTED_TOOLS.has(tool.name) ? exposeToolToWidget(tool) : tool;
  const inputSchema = { ...tool.inputSchema };
  let description = tool.description;
  if (tool.name === 'create-lipsync') {
    for (const key of ['video', 'image', 'audio']) delete inputSchema[key];
    description =
      'Create one lipsync generation from exactly one image/video URL or Sync asset ID and one audio URL/asset ID or script plus a voiceId returned by voices_get-voices. Defaults to sync-3; supply projectId for an existing project or projectName to find or create one; otherwise the client default is used. Poll the returned id with generate_get-generation.';
    for (const key of ['videoAssetId', 'imageAssetId', 'audioAssetId']) {
      inputSchema[key] = z
        .string()
        .optional()
        .describe(
          profile.supportsFilePicker
            ? 'Verified Sync asset ID in the same organization. For a local file, open-media-upload and wait for the card to return its saved asset ID.'
            : 'Existing Sync asset ID in the same organization. Upload in authenticated Sync and use Copy ID.',
        );
    }
    inputSchema.videoUrl = z
      .string()
      .optional()
      .describe('Public or Sync-hosted video URL. Supply exactly one visual input.');
  }
  const meta = Object.fromEntries(
    Object.entries(tool.meta ?? {}).filter(
      ([key]) =>
        !key.startsWith('openai/') &&
        (profile.supportsAppUi ||
          (profile.supportsFilePicker && UPLOAD_CARD_TOOLS.has(tool.name)) ||
          key !== 'ui'),
    ),
  );
  const presented = { ...tool, inputSchema, description, meta };
  return (profile.supportsAppUi && WIDGET_CALLABLE_HOSTED_TOOLS.has(tool.name)) ||
    (profile.supportsFilePicker && UPLOAD_CARD_TOOLS.has(tool.name))
    ? exposeToolToWidget(presented, false)
    : presented;
}
