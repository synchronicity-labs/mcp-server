import type { SyncMcpConfig } from '../config.js';
import { createApiKeyAuth } from './api-key.js';
import { performDeviceAuth } from './device-auth.js';
import { loadToken } from './token-store.js';

export async function resolveLocalAuth(
  config: SyncMcpConfig,
  log: (message: string) => void,
): Promise<Record<string, string>> {
  if (config.apiKey) {
    log('Using API key authentication\n');
    return createApiKeyAuth(config.apiKey).headers;
  }

  const cachedToken = await loadToken(config.baseUrl);
  if (cachedToken) {
    log('Using cached device auth token\n');
    return {
      Authorization: `Bearer ${cachedToken}`,
      'x-sync-source': 'mcp',
    };
  }

  log('No API key or cached token found. Starting device auth...\n');
  const auth = await performDeviceAuth(config.baseUrl, log);
  return auth.headers;
}
