import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createApiKeyAuth } from './auth/api-key.js';
import { performDeviceAuth } from './auth/device-auth.js';
import { loadToken } from './auth/token-store.js';
import type { SyncMcpConfig } from './config.js';
import { createHttpClient, type HttpClient } from './http-client.js';
import { fetchSpec } from './openapi/fetcher.js';
import { parseSpec } from './openapi/parser.js';
import { generateTools } from './tools/generator.js';

export async function createSyncMcpServer(config: SyncMcpConfig): Promise<McpServer> {
  const log = (message: string) => {
    process.stderr.write(message);
  };

  let httpClient: HttpClient;

  if (config.transport === 'http') {
    // HTTP transport: auth comes per-request via AsyncLocalStorage (OAuth bearer token).
    // No static auth headers needed — the httpClient reads from async context.
    log('HTTP transport: auth will be resolved per-request via OAuth\n');
    httpClient = createHttpClient(config.baseUrl);
  } else {
    // Stdio transport: auth resolved once at startup (API key or device auth)
    const authHeaders = await resolveAuth(config, log);
    httpClient = createHttpClient(config.baseUrl, authHeaders);
  }

  log(`Fetching OpenAPI spec from ${config.baseUrl}...\n`);
  const spec = await fetchSpec(config.baseUrl);
  const operations = parseSpec(spec);
  log(`Discovered ${operations.length} API operations\n`);

  const tools = generateTools(operations, httpClient);

  const server = new McpServer({
    name: 'sync',
    version: '0.1.0',
  });

  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.inputSchema, async (args) => {
      try {
        const result = await tool.handler((args ?? {}) as Record<string, unknown>);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    });
  }

  log(`Registered ${tools.length} MCP tools\n`);

  return server;
}

async function resolveAuth(
  config: SyncMcpConfig,
  log: (message: string) => void,
): Promise<Record<string, string>> {
  if (config.apiKey) {
    log('Using API key authentication\n');
    return createApiKeyAuth(config.apiKey).headers;
  }

  const cachedToken = await loadToken();
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
