import { z } from 'zod';
import { resolveChatgptRelease } from './chatgpt-release.js';

export type SyncMcpConfig = {
  apiKey?: string;
  baseUrl: string;
  transport: 'stdio' | 'http';
  port: number;
  chatgptApp?: {
    directory: string;
    previousDirectories?: string[];
    domain: string;
    claudeMcpUrl?: string;
    resourceDomains: string[];
    connectDomains?: string[];
    uploadStorageOrigin?: string;
    uploadOrigins?: string[];
  };
};

export const DEFAULT_CONFIG: SyncMcpConfig = {
  baseUrl: 'https://api.sync.so',
  transport: 'stdio',
  port: 3002,
};

export function resolveConfig(overrides: Partial<SyncMcpConfig> = {}): SyncMcpConfig {
  const legacyDirectory = process.env.SYNC_CHATGPT_APP_DIR;
  const catalogPath = process.env.SYNC_CHATGPT_APP_RELEASES;
  let release: { directory: string; previousDirectories: string[] } | undefined;
  if (
    !overrides.chatgptApp &&
    (legacyDirectory || (catalogPath && process.env.SYNC_CHATGPT_APP_DOMAIN))
  ) {
    const previous = z
      .array(z.string().min(1))
      .parse(JSON.parse(process.env.SYNC_CHATGPT_APP_PREVIOUS_DIRS ?? '[]'));
    release = catalogPath
      ? resolveChatgptRelease(catalogPath, [
          ...previous,
          ...(legacyDirectory ? [legacyDirectory] : []),
        ])
      : { directory: legacyDirectory as string, previousDirectories: previous };
  }
  return {
    apiKey: overrides.apiKey ?? process.env.SYNC_API_KEY,
    baseUrl: overrides.baseUrl ?? process.env.SYNC_BASE_URL ?? DEFAULT_CONFIG.baseUrl,
    transport: overrides.transport ?? DEFAULT_CONFIG.transport,
    port: overrides.port ?? DEFAULT_CONFIG.port,
    chatgptApp:
      overrides.chatgptApp ??
      (release
        ? {
            ...release,
            domain: process.env.SYNC_CHATGPT_APP_DOMAIN ?? '',
            claudeMcpUrl: process.env.SYNC_CLAUDE_APP_MCP_URL,
            uploadStorageOrigin: process.env.SYNC_APP_UPLOAD_STORAGE_ORIGIN,
            uploadOrigins: process.env.SYNC_APP_UPLOAD_ORIGINS
              ? JSON.parse(process.env.SYNC_APP_UPLOAD_ORIGINS)
              : undefined,
            connectDomains: JSON.parse(process.env.SYNC_CHATGPT_APP_CONNECT_DOMAINS ?? '[]'),
            resourceDomains: JSON.parse(process.env.SYNC_CHATGPT_APP_RESOURCE_DOMAINS ?? '[]'),
          }
        : undefined),
  };
}
