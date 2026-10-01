export type SyncMcpConfig = {
  apiKey?: string;
  baseUrl: string;
  transport: 'stdio' | 'http';
  port: number;
  chatgptApp?: {
    directory: string;
    previousDirectories?: string[];
    domain: string;
    resourceDomains: string[];
    connectDomains?: string[];
    uploadStorageOrigin?: string;
  };
};

export const DEFAULT_CONFIG: SyncMcpConfig = {
  baseUrl: 'https://api.sync.so',
  transport: 'stdio',
  port: 3002,
};

export function resolveConfig(overrides: Partial<SyncMcpConfig> = {}): SyncMcpConfig {
  return {
    apiKey: overrides.apiKey ?? process.env.SYNC_API_KEY,
    baseUrl: overrides.baseUrl ?? process.env.SYNC_BASE_URL ?? DEFAULT_CONFIG.baseUrl,
    transport: overrides.transport ?? DEFAULT_CONFIG.transport,
    port: overrides.port ?? DEFAULT_CONFIG.port,
    chatgptApp:
      overrides.chatgptApp ??
      (process.env.SYNC_CHATGPT_APP_DIR
        ? {
            directory: process.env.SYNC_CHATGPT_APP_DIR,
            previousDirectories: JSON.parse(process.env.SYNC_CHATGPT_APP_PREVIOUS_DIRS ?? '[]'),
            domain: process.env.SYNC_CHATGPT_APP_DOMAIN ?? '',
            uploadStorageOrigin: process.env.SYNC_APP_UPLOAD_STORAGE_ORIGIN,
            connectDomains: JSON.parse(process.env.SYNC_CHATGPT_APP_CONNECT_DOMAINS ?? '[]'),
            resourceDomains: JSON.parse(process.env.SYNC_CHATGPT_APP_RESOURCE_DOMAINS ?? '[]'),
          }
        : undefined),
  };
}
