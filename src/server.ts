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

export const SERVER_INSTRUCTIONS =
  'For lipsync requests, prefer create-lipsync. If the user asks an image or video to say text, call voices_get-voices, then create-lipsync with script + voiceId and the image/video URL or Sync assetId. Do not call tts_create for that flow. In ChatGPT, if the user already attached media in chat, use upload-media or direct create-lipsync file params and then call generate_get-generation once with wait: true and timeout: 55. If the user wants to upload or choose a local image or audio file and has not attached it yet, call open-upload-widget by default with requestedMediaType: "image" or "audio". For image-to-speech requests with no attached image, call open-upload-widget with requestedMediaType: "image" and tell the user to enter the exact requested text in the widget Script field. Critical video rule: open-upload-widget is image/audio only. Never call, recommend, or describe open-upload-widget for local video or MP4 requests, even if the user says widget. Never mention requestedMediaType: "video"; it is invalid. For any local MP4/video, the first step is attaching the video to the ChatGPT composer. After it is attached, use upload-media or direct create-lipsync file params. If the user provides a public media URL, pass it directly as imageUrl, videoUrl, or audioUrl. After generate_get-generation returns COMPLETED, copy the exact structuredContent.outputUrl string verbatim; never reconstruct, shorten, or edit signed result URLs.';

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
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        _meta: createToolDescriptorMeta(tool.meta),
      },
      async (args): Promise<CallToolResult> => {
        try {
          if (tool.resultFormat === 'mcp') {
            return tool.handler((args ?? {}) as Record<string, unknown>);
          }
          const result = await tool.handler((args ?? {}) as Record<string, unknown>);
          return createJsonToolResult(result, tool.outputSchema);
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

export function createJsonToolResult(
  result: unknown,
  outputSchema?: Record<string, unknown>,
): CallToolResult {
  const resultForClient =
    outputSchema && isStructuredContent(result)
      ? pickOutputSchemaFields(result, outputSchema)
      : result;
  const callToolResult: CallToolResult = {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(resultForClient, null, 2),
      },
    ],
  };

  if (isStructuredContent(resultForClient)) {
    callToolResult.structuredContent = resultForClient;
  }

  return callToolResult;
}

function pickOutputSchemaFields(
  result: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(outputSchema)) {
    if (key in result) {
      picked[key] = result[key];
    }
  }
  return picked;
}

function isStructuredContent(result: unknown): result is Record<string, unknown> {
  return result !== null && typeof result === 'object' && !Array.isArray(result);
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
