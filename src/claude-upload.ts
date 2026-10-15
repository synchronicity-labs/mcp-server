import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type ChatgptApp, loadChatgptApp } from './chatgpt-app.js';
import type { ClientProfile } from './client-profile.js';
import type { SyncMcpConfig } from './config.js';
import type { McpToolDefinition } from './tools/generator.js';

const exactOrigin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.origin === value && !value.includes('*');
}, 'Use an exact HTTPS origin without wildcards, credentials or paths.');
const settings = z.object({
  mcpUrl: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !value.includes('*')
    );
  }, 'Use the exact public HTTPS MCP URL.'),
  storageOrigin: exactOrigin,
  directory: z.string().min(1).optional(),
});

export function claudeUploadSettings(config: SyncMcpConfig['claudeUpload']) {
  if (!config) return undefined;
  const input = settings.parse(config);
  return {
    ...input,
    origin: new URL(input.mcpUrl).origin,
    sandboxOrigin: `https://${createHash('sha256').update(input.mcpUrl).digest('hex').slice(0, 32)}.claudemcpcontent.com`,
  };
}

export async function loadClaudeUploadApp(
  config: SyncMcpConfig['claudeUpload'],
): Promise<ChatgptApp | undefined> {
  const input = claudeUploadSettings(config);
  if (!input) return undefined;
  const app = await loadChatgptApp({
    directory: input.directory ?? fileURLToPath(new URL('./claude-upload/', import.meta.url)),
    domain: input.origin,
    claudeMcpUrl: input.mcpUrl,
    resourceDomains: [],
    connectDomains: [input.origin],
  });
  if (!app) throw new Error('Claude upload resource is unavailable.');
  return {
    ...app,
    metadata: {
      title: 'Upload to Sync',
      description:
        'Choose a local video, image or audio file and save it to the connected Sync organization.',
      mimeType: app.metadata.mimeType,
      _meta: {
        ui: {
          domain: new URL(input.sandboxOrigin).host,
          prefersBorder: true,
          csp: { connectDomains: [input.origin], resourceDomains: ['blob:'] },
        },
      },
    },
  };
}

export function createClaudeUploadTool(app: ChatgptApp): McpToolDefinition {
  return {
    name: 'open-media-upload',
    title: 'Upload to Sync',
    description:
      'Open the Sync upload card inside Claude when the user wants to upload a local video, image or audio file. The user chooses the file in this card; it cannot automatically read attachments already added through Claude’s composer. Wait for its returned asset ID before generating. Opening the card does not upload or generate anything. Do not claim it rendered until the user or card confirms it.',
    inputSchema: {},
    outputSchema: { requested: z.boolean(), renderStatus: z.literal('awaiting_client') },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    meta: { ui: { resourceUri: app.uri, visibility: ['model', 'app'] } },
    handler: async () => ({ requested: true, renderStatus: 'awaiting_client' }),
  };
}

export function registerClaudeUploadResource(
  server: McpServer,
  app: ChatgptApp,
  getProfile: () => ClientProfile,
): Resource {
  server.registerResource('claude-upload', app.uri, app.metadata, async () => {
    if (!getProfile().supportsFilePicker)
      throw new Error('The Sync upload card is not available in this connection.');
    return {
      contents: [
        {
          uri: app.uri,
          mimeType: app.metadata.mimeType,
          text: app.html,
          _meta: app.metadata._meta,
        },
      ],
    };
  });
  return { name: 'claude-upload', uri: app.uri, ...app.metadata };
}
