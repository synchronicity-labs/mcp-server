import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResourceMetadata } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SyncMcpConfig } from './config.js';
import type { McpToolDefinition } from './tools/index.js';
import { MCP_APP_RESOURCE_MIME_TYPE } from './tools/upload-widget.js';

const originSchema = z
  .url({ protocol: /^https$/ })
  .refine(
    (value) => !value.includes('*') && new URL(value).origin === value,
    'Use an exact HTTPS origin without paths, credentials, or wildcards.',
  );
const configSchema = z.object({
  directory: z.string().min(1),
  domain: originSchema,
  resourceDomains: originSchema.array(),
  connectDomains: originSchema.array().default([]),
});
const manifestSchema = z.object({
  version: z.literal(1),
  file: z.literal('app.html'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ChatgptApp = {
  uri: string;
  html: string;
  metadata: ResourceMetadata;
};

async function readBounded(path: string, limit: number): Promise<Buffer> {
  if ((await stat(path)).size > limit)
    throw new Error('ChatGPT app artifact exceeds its size limit.');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('ChatGPT app artifact exceeds its size limit.');
  return bytes;
}

/** Load once per server factory so every session serves the same verified bytes. */
export async function loadChatgptApp(
  config: SyncMcpConfig['chatgptApp'],
): Promise<ChatgptApp | undefined> {
  if (!config) return undefined;
  const { directory, domain, resourceDomains, connectDomains } = configSchema.parse(config);
  const manifest = manifestSchema.parse(
    JSON.parse((await readBounded(join(directory, 'manifest.json'), 4096)).toString('utf8')),
  );
  const bytes = await readBounded(join(directory, manifest.file), 8 * 1024 * 1024);
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256)
    throw new Error('ChatGPT app SHA256 does not match its release manifest.');
  return {
    uri: `ui://sync/app-${manifest.sha256}.html`,
    html: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    metadata: {
      title: 'Sync',
      description: 'Browse your Sync projects and create videos using your existing assets.',
      mimeType: MCP_APP_RESOURCE_MIME_TYPE,
      _meta: {
        ui: { domain, prefersBorder: true, csp: { connectDomains, resourceDomains } },
        'openai/widgetDomain': domain,
        'openai/widgetCSP': { connect_domains: connectDomains, resource_domains: resourceDomains },
        'openai/widgetPrefersBorder': true,
        'openai/widgetDescription':
          'Sync projects and video creation interface. A successful open request does not confirm that the interface has rendered.',
        'openai/ui': { availableDisplayModes: ['inline'] },
      },
    },
  };
}

/** Retain immutable releases so cached tool descriptors remain readable after upgrades. */
export async function loadChatgptAppReleases(
  config: SyncMcpConfig['chatgptApp'],
): Promise<ChatgptApp[]> {
  if (!config) return [];
  const previous = z
    .array(z.string().min(1))
    .max(8)
    .parse(config.previousDirectories ?? []);
  const apps = await Promise.all(
    [config.directory, ...previous].map((directory) => loadChatgptApp({ ...config, directory })),
  );
  return [
    ...new Map(
      apps.filter((app): app is ChatgptApp => !!app).map((app) => [app.uri, app]),
    ).values(),
  ];
}

export function createOpenSyncAppTool(app: ChatgptApp): McpToolDefinition {
  return {
    name: 'open-sync-app',
    title: 'Open Sync',
    description:
      'Open Sync to browse existing projects, choose media and configure a video generation. Requesting the interface does not start a generation or spend credits. The result only confirms the request; do not claim the interface rendered unless the user confirms it.',
    inputSchema: {},
    outputSchema: { requested: z.boolean(), renderStatus: z.literal('awaiting_client') },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    meta: {
      ui: { resourceUri: app.uri },
      'openai/outputTemplate': app.uri,
      'openai/toolInvocation/invoking': 'Preparing Sync',
      'openai/toolInvocation/invoked': 'Sync interface requested',
      'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
    },
    handler: async () => ({ requested: true, renderStatus: 'awaiting_client' }),
  };
}
