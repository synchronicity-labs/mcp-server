import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type CallToolResult,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  type Resource,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createApiKeyAuth } from './auth/api-key.js';
import { performDeviceAuth } from './auth/device-auth.js';
import { loadToken } from './auth/token-store.js';
import {
  type ClientProfile,
  resolveClientProfile,
  UNSUPPORTED_UPLOAD_MESSAGE,
} from './client-profile.js';
import type { SyncMcpConfig } from './config.js';
import { createHttpClient } from './http-client.js';
import { fetchSpec } from './openapi/fetcher.js';
import { parseSpec } from './openapi/parser.js';
import { createAppTools } from './tools/app-tools.js';
import { generateTools, operationIdToToolName } from './tools/generator.js';
import type { McpToolDefinition } from './tools/index.js';
import { createUploadWidgetTool, registerUploadWidgetResource } from './tools/upload-widget.js';

const SERVER_DESCRIPTION =
  'Sync is an AI video platform for lipsync and visual dubbing. ' +
  'The MCP server creates lipsync videos from image or video inputs with audio or text, manages media assets, and reports generation status.';

export const SERVER_INSTRUCTIONS =
  'create-lipsync accepts exactly one visual input (image or video) and one driver (audio or script). For script, call voices_get-voices and select an actual returned voiceId. Public/Sync-hosted media URLs and existing Sync asset IDs in the same organization are supported. For local media, upload in authenticated Sync and use Copy ID (or Copy URL). The tool defaults to sync-3 and an integration-specific project unless projectName is supplied. Create once, then poll generate_get-generation by the returned id with wait: true and timeout: 55; if still pending, poll that same id rather than creating again. When COMPLETED, return the exact structuredContent.outputUrl verbatim, preserving signed query parameters.';

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

export function registerTools(server: McpServer, tools: McpToolDefinition[]): void {
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
      async (args, context): Promise<CallToolResult> => {
        try {
          if (tool.resultFormat === 'mcp') {
            return await tool.handler((args ?? {}) as Record<string, unknown>, context);
          }
          const result = await tool.handler((args ?? {}) as Record<string, unknown>, context);
          return createJsonToolResult(result, tool.outputSchema);
        } catch (error) {
          return createToolErrorResult(error);
        }
      },
    );
  }
}

export function createToolErrorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const retryableError =
    error && typeof error === 'object'
      ? (error as { code?: unknown; retryable?: unknown; retryAfterMs?: unknown })
      : {};
  if (
    typeof retryableError.code === 'string' &&
    retryableError.retryable === true &&
    typeof retryableError.retryAfterMs === 'number'
  ) {
    const structuredContent = {
      error: {
        message,
        code: retryableError.code,
        retryable: true,
        retryAfterMs: retryableError.retryAfterMs,
      },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
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

export function selectHostedHttpTools(
  tools: McpToolDefinition[],
  profile: ClientProfile = resolveClientProfile(),
): McpToolDefinition[] {
  return tools
    .filter((tool) => HOSTED_HTTP_TOOL_ALLOWLIST.has(tool.name))
    .filter(
      (tool) =>
        profile.supportsUploads || !['upload-media', 'open-upload-widget'].includes(tool.name),
    )
    .map((tool) => presentTool(tool, profile));
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

/** Session-local descriptors and presentation. Authentication remains request-scoped. */
function presentTool(tool: McpToolDefinition, profile: ClientProfile): McpToolDefinition {
  if (profile.supportsUploads)
    return WIDGET_CALLABLE_HOSTED_TOOLS.has(tool.name) ? exposeToolToWidget(tool) : tool;
  const inputSchema = { ...tool.inputSchema };
  let description = tool.description;
  if (tool.name === 'create-lipsync') {
    for (const key of ['video', 'image', 'audio']) delete inputSchema[key];
    description =
      'Create one lipsync generation from exactly one image/video URL or Sync asset ID and one audio URL/asset ID or script plus a voiceId returned by voices_get-voices. Defaults to sync-3; explicit projectName overrides the client default. Poll the returned id with generate_get-generation.';
    for (const key of ['videoAssetId', 'imageAssetId', 'audioAssetId']) {
      inputSchema[key] = z
        .string()
        .optional()
        .describe(
          'Existing Sync asset ID in the same organization. Upload in authenticated Sync and use Copy ID.',
        );
    }
    inputSchema.videoUrl = z
      .string()
      .optional()
      .describe('Public or Sync-hosted video URL. Supply exactly one visual input.');
  }
  const meta = Object.fromEntries(
    Object.entries(tool.meta ?? {}).filter(([key]) => !key.startsWith('openai/') && key !== 'ui'),
  );
  return { ...tool, inputSchema, description, meta };
}

function createProfiledServer(
  config: SyncMcpConfig,
  operations: ReturnType<typeof parseSpec>,
  authHeaders: Record<string, string> = {},
): McpServer {
  let profile: ClientProfile | undefined;
  let clientName: string | undefined;
  const getProfile = () => profile ?? resolveClientProfile();
  const httpClient = createHttpClient(
    config.baseUrl,
    authHeaders,
    config.transport === 'stdio' ? () => clientName : undefined,
  );
  const allTools = [
    createUploadWidgetTool(),
    ...createAppTools(httpClient, undefined, getProfile),
    ...generateTools(operations, httpClient),
  ];
  const tools =
    config.transport === 'http'
      ? allTools.filter((tool) => HOSTED_HTTP_TOOL_ALLOWLIST.has(tool.name))
      : allTools;
  const server = new McpServer(
    { name: 'sync', version: '0.1.0', description: SERVER_DESCRIPTION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  // Keep the SDK's input/output validation and execution. Hidden upload tools remain
  // callable only to return an actionable error; they cannot perform any upload.
  registerTools(
    server,
    tools.map(
      (tool) =>
        ({
          ...tool,
          handler: async (...parameters: Parameters<typeof tool.handler>) => {
            const [args] = parameters;
            if (!profile) throw new Error('Complete MCP initialization before calling tools.');
            if (
              !profile.supportsUploads &&
              (['upload-media', 'open-upload-widget'].includes(tool.name) ||
                (tool.name === 'create-lipsync' &&
                  ['video', 'image', 'audio'].some((key) => args[key] !== undefined)))
            ) {
              throw new Error(UNSUPPORTED_UPLOAD_MESSAGE);
            }
            return tool.handler.apply(undefined, parameters);
          },
        }) as McpToolDefinition,
    ),
  );
  const resources: Resource[] = [];
  registerUploadWidgetResource({
    registerResource: (name, uri, metadata, read) => {
      resources.push({ name, uri, ...metadata });
      return server.registerResource(name, uri, metadata, async (url, extra) => {
        if (!getProfile().supportsUploads) throw new Error(UNSUPPORTED_UPLOAD_MESSAGE);
        return read(url, extra);
      });
    },
  });
  let descriptors: Tool[] = [];
  server.server.setRequestHandler(ListToolsRequestSchema, () => {
    if (!profile) throw new Error('Complete MCP initialization before listing tools.');
    return { tools: descriptors };
  });
  server.server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: getProfile().supportsUploads ? resources : [],
  }));
  const onInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    if (!profile) {
      clientName = server.server.getClientVersion()?.name;
      const initializedProfile = resolveClientProfile(clientName);
      profile = initializedProfile;
      const visible =
        config.transport === 'http'
          ? selectHostedHttpTools(tools, initializedProfile)
          : tools
              .filter(
                (tool) =>
                  initializedProfile.supportsUploads ||
                  !['upload-media', 'open-upload-widget'].includes(tool.name),
              )
              .map((tool) => presentTool(tool, initializedProfile));
      descriptors = visible.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: z.toJSONSchema(z.object(tool.inputSchema)) as Tool['inputSchema'],
        ...(tool.outputSchema
          ? { outputSchema: z.toJSONSchema(z.object(tool.outputSchema)) as Tool['outputSchema'] }
          : {}),
        annotations: tool.annotations,
        _meta: createToolDescriptorMeta(tool.meta),
      }));
    }
    onInitialized?.();
  };
  return server;
}

export async function createSyncMcpServer(config: SyncMcpConfig): Promise<McpServer> {
  const log = (message: string) => {
    process.stderr.write(message);
  };
  const authHeaders = config.transport === 'http' ? {} : await resolveAuth(config, log);
  const operations = parseSpec(await fetchSpec(config.baseUrl));
  return createProfiledServer(config, operations, authHeaders);
}

export async function createMcpServerFactory(
  config: SyncMcpConfig,
): Promise<{ createServer: () => McpServer; toolCount: number }> {
  // Filter once before constructing per-session schemas. Handlers and profile
  // state remain session-local, but excluded API operations do no session work.
  const operations = parseSpec(await fetchSpec(config.baseUrl)).filter((operation) =>
    HOSTED_HTTP_TOOL_ALLOWLIST.has(operationIdToToolName(operation.operationId)),
  );
  const registeredNames = new Set([
    'open-upload-widget',
    'upload-media',
    'create-lipsync',
    ...operations.map((operation) => operationIdToToolName(operation.operationId)),
  ]);
  return {
    // Number registered across hosted profiles, not each client's visible catalog.
    toolCount: registeredNames.size,
    createServer: () => createProfiledServer(config, operations),
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
