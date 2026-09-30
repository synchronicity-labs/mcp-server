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
  const { directory, domain, resourceDomains } = configSchema.parse(config);
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
      _meta: { ui: { domain, prefersBorder: true, csp: { connectDomains: [], resourceDomains } } },
    },
  };
}

export function createOpenSyncAppTool(app: ChatgptApp): McpToolDefinition {
  return {
    name: 'open-sync-app',
    title: 'Open Sync',
    description:
      'Open Sync to browse existing projects, choose media and configure a video generation. Opening the interface does not start a generation or spend credits.',
    inputSchema: {},
    outputSchema: { opened: z.boolean() },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    meta: {
      ui: { resourceUri: app.uri },
      'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
    },
    handler: async () => ({ opened: true }),
  };
}
