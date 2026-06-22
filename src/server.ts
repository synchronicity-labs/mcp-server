import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createApiKeyAuth } from './auth/api-key.js';
import { performDeviceAuth } from './auth/device-auth.js';
import { loadToken } from './auth/token-store.js';
import type { SyncMcpConfig } from './config.js';
import { createHttpClient, type HttpClient, setStaticClientName } from './http-client.js';
import { fetchSpec } from './openapi/fetcher.js';
import { parseSpec } from './openapi/parser.js';
import { createAppTools } from './tools/app-tools.js';
import { generateTools } from './tools/generator.js';
import type { McpToolDefinition } from './tools/index.js';
import { createUploadWidgetTool, registerUploadWidgetResource } from './tools/upload-widget.js';

const SERVER_DESCRIPTION =
  'Sync is an AI video platform for lipsync and visual dubbing. ' +
  'Create lipsync videos by providing a video URL and audio URL — Sync generates a video with perfectly synchronized lip movements. ' +
  'Typical workflow: generate_create-generation → poll generate_get-generation until COMPLETED → return output URL.';

const SERVER_INSTRUCTIONS =
  'For lipsync requests, prefer create-lipsync. If the user asks an image or video to say text, call voices_get-voices, then create-lipsync with script + voiceId and the image/video URL or Sync assetId. Do not call tts_create for that flow. In ChatGPT, if the user uploads media in chat or needs to pick a local file, open open-upload-widget first so the user can select or upload the file through the app bridge; for "make it say X" requests, pass requestedMediaType and the exact text X as open-upload-widget.script so the widget can finish the lipsync flow. If the host directly supplies file params, upload-media can stage a single file to a Sync assetId. If the user provides a public media URL, pass it directly as imageUrl, videoUrl, or audioUrl. Poll generate_get-generation until COMPLETED and return outputUrl.';

const TOOL_SECURITY_SCHEMES = [{ type: 'oauth2', scopes: [] }] as const;
const HOSTED_HTTP_TOOL_ALLOWLIST = new Set([
  'open-upload-widget',
  'upload-media',
  'create-lipsync',
  'voices_get-voices',
  'generate_get-generation',
]);
const WIDGET_CALLABLE_HOSTED_TOOLS = new Set([
  'upload-media',
  'create-lipsync',
  'voices_get-voices',
  'generate_get-generation',
]);

export function createToolDescriptorMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...meta,
    securitySchemes: meta?.securitySchemes ?? TOOL_SECURITY_SCHEMES,
  };
}

function registerTools(server: McpServer, tools: McpToolDefinition[]): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        _meta: createToolDescriptorMeta(tool.meta),
      },
      async (args): Promise<CallToolResult> => {
        try {
          if (tool.resultFormat === 'mcp') {
            return tool.handler((args ?? {}) as Record<string, unknown>);
          }
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
      },
    );
  }
}

export function selectHostedHttpTools(tools: McpToolDefinition[]): McpToolDefinition[] {
  return tools
    .filter((tool) => HOSTED_HTTP_TOOL_ALLOWLIST.has(tool.name))
    .map((tool) => (WIDGET_CALLABLE_HOSTED_TOOLS.has(tool.name) ? exposeToolToWidget(tool) : tool));
}

function exposeToolToWidget(tool: McpToolDefinition): McpToolDefinition {
  const meta = tool.meta ?? {};
  const ui = asRecord(meta.ui);
  return {
    ...tool,
    meta: {
      ...meta,
      ui: {
        ...ui,
        visibility: ['model', 'app'],
      },
      'openai/widgetAccessible': true,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Creates a single MCP server instance for stdio transport.
 */
export async function createSyncMcpServer(config: SyncMcpConfig): Promise<McpServer> {
  const log = (message: string) => {
    process.stderr.write(message);
  };

  let httpClient: HttpClient;

  if (config.transport === 'http') {
    log('HTTP transport: auth will be resolved per-request via OAuth\n');
    httpClient = createHttpClient(config.baseUrl);
  } else {
    const authHeaders = await resolveAuth(config, log);
    httpClient = createHttpClient(config.baseUrl, authHeaders);
  }

  log(`Fetching OpenAPI spec from ${config.baseUrl}...\n`);
  const spec = await fetchSpec(config.baseUrl);
  const operations = parseSpec(spec);
  log(`Discovered ${operations.length} API operations\n`);

  const tools = [
    createUploadWidgetTool(),
    ...createAppTools(httpClient),
    ...generateTools(operations, httpClient),
  ];
  const server = new McpServer(
    { name: 'sync', version: '0.1.0', description: SERVER_DESCRIPTION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerUploadWidgetResource(server);
  registerTools(server, tools);
  log(`Registered ${tools.length} MCP tools\n`);

  server.server.oninitialized = () => {
    const clientVersion = server.server.getClientVersion();
    if (clientVersion?.name) {
      setStaticClientName(clientVersion.name);
    }
  };

  return server;
}

/**
 * Creates a factory that produces new McpServer instances.
 * Used by HTTP transport where each session needs its own server instance.
 */
export async function createMcpServerFactory(
  config: SyncMcpConfig,
): Promise<{ createServer: () => McpServer; toolCount: number }> {
  const log = (message: string) => {
    process.stderr.write(message);
  };

  log('HTTP transport: auth will be resolved per-request via OAuth\n');
  const httpClient = createHttpClient(config.baseUrl);

  log(`Fetching OpenAPI spec from ${config.baseUrl}...\n`);
  const spec = await fetchSpec(config.baseUrl);
  const operations = parseSpec(spec);
  log(`Discovered ${operations.length} API operations\n`);

  const tools = selectHostedHttpTools([
    createUploadWidgetTool(),
    ...createAppTools(httpClient),
    ...generateTools(operations, httpClient),
  ]);

  return {
    toolCount: tools.length,
    createServer: () => {
      const server = new McpServer(
        {
          name: 'sync',
          version: '0.1.0',
          description: SERVER_DESCRIPTION,
        },
        { instructions: SERVER_INSTRUCTIONS },
      );
      registerUploadWidgetResource(server);
      registerTools(server, tools);
      return server;
    },
  };
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
    };
  }

  log('No API key or cached token found. Starting device auth...\n');
  const auth = await performDeviceAuth(config.baseUrl, log);
  return auth.headers;
}
