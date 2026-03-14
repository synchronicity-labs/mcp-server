export type SyncMcpConfig = {
  apiKey?: string;
  baseUrl: string;
  transport: 'stdio' | 'http';
  port: number;
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
  };
}
