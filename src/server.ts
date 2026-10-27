import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type CallToolResult,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  type Resource,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { relayUploadTool } from './app-upload-relay.js';
import { ASSET_THUMBNAIL_INSTRUCTIONS } from './asset-thumbnail.js';
import { createApiKeyAuth } from './auth/api-key.js';
import { performDeviceAuth } from './auth/device-auth.js';
import { loadToken } from './auth/token-store.js';
import { type ChatgptApp, createOpenSyncAppTool, loadChatgptAppReleases } from './chatgpt-app.js';
import {
  type ClientProfile,
  resolveClientProfile,
  UNSUPPORTED_UPLOAD_MESSAGE,
} from './client-profile.js';
import type { SyncMcpConfig } from './config.js';
import { ApiRequestError, createHttpClient } from './http-client.js';
import { fetchSpec } from './openapi/fetcher.js';
import { parseSpec } from './openapi/parser.js';
import { createAccountContextTool } from './tools/account-context.js';
import { createAccountManagementTools } from './tools/account-management.js';
import { createAppTools } from './tools/app-tools.js';
import { createAssetCreatorsTool } from './tools/asset-creators.js';
import { createDialogueTools, dialogueOperations } from './tools/dialogue.js';
import { createGenerationContinuationTool } from './tools/generation-continuation.js';
import { createGenerationFeedbackTools } from './tools/generation-feedback.js';
import { generateTools, operationIdToToolName } from './tools/generator.js';
import type { McpToolDefinition } from './tools/index.js';
import {
  createPlatformImportTools,
  isPlatformImportOperation,
  supportsPlatformImports,
} from './tools/platform-import.js';
import { createPlaybackMetadataTool } from './tools/playback-metadata.js';
import { createProjectHistoryTools } from './tools/project-history.js';
import { createSpeechTools, speechOperations } from './tools/speech.js';
import { createStudioDraftTools, supportsStudioDrafts } from './tools/studio-draft.js';
import { createStudioViewTools, supportsStudioViews } from './tools/studio-view.js';
import { createTranslationTools, translationOperation } from './tools/translation.js';
import {
  createTranslationPreviewTools,
  translationPreviewOperations,
} from './tools/translation-preview.js';
import { createUploadWidgetTool, registerUploadWidgetResource } from './tools/upload-widget.js';

const SERVER_DESCRIPTION =
  'Sync makes photos talk, lip-syncs videos to audio or a script, translates and dubs videos into another language, and edits spoken words while keeping the original speaker voice. ' +
  'Use existing media or upload your own. Check available workflows and estimated generation costs before creating a video.';

export const SERVER_INSTRUCTIONS =
  ASSET_THUMBNAIL_INSTRUCTIONS +
  'In ChatGPT, default new lipsync and image-to-video requests to sync-3, the latest lipsync model, unless the user explicitly chooses another model. Preserve the selected model on an existing draft or an idempotent retry. ' +
  'When voices_clone-voice is available, use it only for an explicitly requested reusable voice clone from a sample the user owns or has permission to clone. Confirm the sample and voice name, explain plan/provider restrictions, and do not claim cloning is free. Use the returned id (not the provider voiceId) for create-lipsync with script. After an uncertain clone response, list voices and reconcile before considering another write; never automatically repeat cloning. ' +
  'Do not offer Sync video workflows for subtitle-only output, text translation, standalone MP3 voiceovers, or timeline editing such as trimming and mixing background music. Explain the supported scope; only offer another capability if a corresponding tool is actually available. ' +
  'Edit Dialogue supports targeted edits/removals of existing timed transcript words, with an audio preview in the original speaker voice followed by create-dialogue-video. It does not support replacing every line with an arbitrary new script. Explain this limit when whole-script replacement is requested; do not promise it or bypass it by splitting the new script into word edits. Do not substitute full-script TTS. Use the dedicated dialogue tools when available; if a required tool is unavailable, explain that the workflow cannot be completed in this connection. ' +
  'When create-translate-and-dub is available, use it for translating speech and lip-syncing a saved video. Before confirming the paid action, use generate_estimate-cost with workflow=translate-and-dub if its schema supports that option. Show the combined Sync estimate and disclose excluded external provider charges. Without that option or the returned breakdown, the estimate covers lip-sync only; do not present it as the full workflow cost. Confirm the target language and configuration. Reuse its generation id for status polling. ' +
  'When standalone translation-preview tools are available, the app can translate saved audio before final lip-sync. Confirm the source audio, language and quote before create-translation-preview. Persist one UUID key and immutable request; poll the same job, and treat recoveryRequired as unresolved acceptance. Never redub because attaching the output failed. After a translated audio preview is saved, estimate and confirm a separate create-lipsync-from-assets using that audio; do not send it through create-translate-and-dub again. ' +
  'When create-speech-preview is available, the app can synthesize a standalone audio preview for its video input. Confirm script, voice and estimated cost. Persist and reuse its idempotencyKey after uncertain admission, poll the same returned job, and never synthesize again because asset attachment failed. ' +
  'When Studio publishes a draftId, use get-studio-draft and update-studio-draft to change its selections/settings. Chat prose does not select media in Studio. Use the current expectedRevision and confirm UI application only after appliedRevision equals revision. These tools do not start paid work. ' +
  'When Studio publishes a viewId, read get-studio-view, then use open-studio-project to open a project, refresh-studio-project after a rename, refresh-studio-assets after uploads, show-studio-generation to display an accepted job/result, or continue-studio-generation for an explicitly requested continuation. Only an applied receipt confirms UI display. Never repeat backend or paid work to refresh the UI. ' +
  'create-lipsync accepts exactly one visual input (image or video) and one driver (audio or script). For script, call voices_get-voices and select an actual returned voiceId. Public/Sync-hosted media URLs and existing Sync asset IDs in the same organization are supported. For local media, use the Sync interface upload action, or request assets_create-upload-url, PUT the file bytes with its Content-Type, and register the returned URL with assets_create. Use assets_create for public URL imports and projects_create to create a project. The tool defaults to sync-3 and an integration-specific project unless projectId or projectName is supplied. Prefer a projectId returned by projects_get-all when selecting an existing project. When available, use projects_get-generations for history within that project; generate_get-generations is the organization feed. Create once, then poll generate_get-generation by the returned id with wait: true, omitting timeout to use the API default; if still pending, poll that same id rather than creating again. When COMPLETED, return the exact structuredContent.outputUrl verbatim, preserving signed query parameters.';

const TOOL_SECURITY_SCHEMES = [{ type: 'oauth2', scopes: [] }] as const;
const APP_UI_TOOLS = new Set([
  'open-sync-app',
  'save-studio-draft',
  'ack-studio-draft',
  'register-studio-view',
  'ack-studio-view',
]);
const HOSTED_HTTP_TOOL_ALLOWLIST = new Set([
  'detect-platform-link',
  'get-platform-link-metadata',
  'start-platform-import',
  'get-platform-import',
  'list-platform-imports',
  'cancel-platform-import',
  'retry-platform-import',
  'get-studio-view',
  'open-studio-project',
  'refresh-studio-project',
  'refresh-studio-assets',
  'show-studio-generation',
  'continue-studio-generation',
  'register-studio-view',
  'ack-studio-view',
  'get-studio-draft',
  'update-studio-draft',
  'save-studio-draft',
  'ack-studio-draft',
  'get-generation-feedback',
  'submit-generation-feedback',
  'get-account-usage',
  'rename-project',
  'get-account-context',
  'get-asset-creators',
  'get-playback-metadata',
  'get-generation-continuation',
  'get-speech-options',
  'create-speech-preview',
  'get-speech-preview',
  'get-dialogue-options',
  'upload-dialogue-source',
  'create-dialogue-transcription',
  'get-dialogue-transcription',
  'create-dialogue-preview',
  'get-dialogue-preview',
  'estimate-dialogue-video',
  'create-dialogue-video',
  'open-sync-app',
  'open-upload-widget',
  'upload-media',
  'create-lipsync',
  'create-lipsync-from-assets',
  'create-translate-and-dub',
  'get-translation-options',
  'estimate-translation-preview',
  'create-translation-preview',
  'get-translation-preview',
  'voices_get-voices',
  'voices_get-voice',
  'voices_delete-voice',
  'voices_clone-voice',
  'generate_get-generation',
  'models_get',
  'projects_get-all',
  'projects_get',
  'assets_get-all',
  'assets_count',
  'assets_get',
  'assets_update',
  'assets_delete',
  'assets_get-download-url',
  'assets_create-upload-url',
  'assets_create',
  'projects_create',
  'generate_get-generations',
  'projects_get-generations',
  'generate_estimate-cost',
]);
const WIDGET_CALLABLE_HOSTED_TOOLS = new Set([
  'detect-platform-link',
  'get-platform-link-metadata',
  'start-platform-import',
  'get-platform-import',
  'list-platform-imports',
  'cancel-platform-import',
  'retry-platform-import',
  'get-studio-view',
  'open-studio-project',
  'refresh-studio-project',
  'refresh-studio-assets',
  'show-studio-generation',
  'continue-studio-generation',
  'register-studio-view',
  'ack-studio-view',
  'get-studio-draft',
  'update-studio-draft',
  'save-studio-draft',
  'ack-studio-draft',
  'get-generation-feedback',
  'submit-generation-feedback',
  'voices_clone-voice',
  'voices_get-voice',
  'voices_delete-voice',
  'get-account-usage',
  'rename-project',
  'get-account-context',
  'get-asset-creators',
  'get-playback-metadata',
  'get-generation-continuation',
  'get-speech-options',
  'create-speech-preview',
  'get-speech-preview',
  'get-dialogue-options',
  'upload-dialogue-source',
  'create-dialogue-transcription',
  'get-dialogue-transcription',
  'create-dialogue-preview',
  'get-dialogue-preview',
  'estimate-dialogue-video',
  'create-dialogue-video',
  'upload-media',
  'create-lipsync',
  'create-lipsync-from-assets',
  'create-translate-and-dub',
  'get-translation-options',
  'estimate-translation-preview',
  'create-translation-preview',
  'get-translation-preview',
  'voices_get-voices',
  'voices_get-voice',
  'voices_delete-voice',
  'generate_get-generation',
  'models_get',
  'projects_get-all',
  'projects_get',
  'assets_get-all',
  'assets_count',
  'assets_get',
  'assets_update',
  'assets_delete',
  'assets_get-download-url',
  'assets_create-upload-url',
  'assets_create',
  'projects_create',
  'generate_get-generations',
  'projects_get-generations',
  'generate_estimate-cost',
]);

export function createToolDescriptorMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...meta,
    securitySchemes: meta?.securitySchemes ?? TOOL_SECURITY_SCHEMES,
  };
}

// SDK clients validate structured errors too. Retained widgets require this
// envelope; success registration and projection remain independently strict.
const toolErrorOutputSchema = z.toJSONSchema(
  z.object({
    error: z.object({
      message: z.string(),
      status: z.number().int().optional(),
      code: z.string().optional(),
      retryable: z.boolean().optional(),
      retryAfterMs: z.number().finite().optional(),
      generationId: z.string().optional(),
    }),
  }),
);

// The SDK wraps raw shapes on registration. Reuse immutable validators across
// sessions while keeping handlers, authentication and client profiles local.
const toolSchemas = new WeakMap<Record<string, z.ZodType>, z.ZodObject>();

function toolSchema(shape: Record<string, z.ZodType>): z.ZodObject {
  let schema = toolSchemas.get(shape);
  if (!schema) {
    schema = z.object(shape);
    toolSchemas.set(shape, schema);
  }
  return schema;
}

export function registerTools(server: McpServer, tools: McpToolDefinition[]): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: toolSchema(tool.inputSchema),
        outputSchema: tool.outputSchema ? toolSchema(tool.outputSchema) : undefined,
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
  if (error instanceof ApiRequestError) {
    const structuredContent = {
      error: {
        message,
        status: error.status,
        ...(error.code ? { code: error.code } : {}),
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        ...(error.generationId ? { generationId: error.generationId } : {}),
      },
    };
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(structuredContent),
        },
      ],
      structuredContent,
      isError: true,
    };
  }
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

function isToolVisible(tool: McpToolDefinition, profile: ClientProfile): boolean {
  if (APP_UI_TOOLS.has(tool.name)) return profile.supportsAppUi;
  if (tool.name === 'create-lipsync-from-assets') return profile.supportsAppUi;
  if (['upload-media', 'open-upload-widget'].includes(tool.name)) return profile.supportsUploads;
  return true;
}

export function selectHostedHttpTools(
  tools: McpToolDefinition[],
  profile: ClientProfile = resolveClientProfile(),
): McpToolDefinition[] {
  return tools
    .filter((tool) => HOSTED_HTTP_TOOL_ALLOWLIST.has(tool.name))
    .filter((tool) => isToolVisible(tool, profile))
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
        visibility: ui.visibility ?? ['model', 'app'],
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

/** Profile-specific descriptors and presentation. Authentication remains request-scoped. */
function presentTool(tool: McpToolDefinition, profile: ClientProfile): McpToolDefinition {
  if (profile.supportsUploads)
    return WIDGET_CALLABLE_HOSTED_TOOLS.has(tool.name) ? exposeToolToWidget(tool) : tool;
  const inputSchema = { ...tool.inputSchema };
  let description = tool.description;
  if (tool.name === 'create-lipsync') {
    for (const key of ['video', 'image', 'audio']) delete inputSchema[key];
    description =
      'Create one lipsync generation from exactly one image/video URL or Sync asset ID and one audio URL/asset ID or script plus a voiceId returned by voices_get-voices. Defaults to sync-3; supply projectId for an existing project or projectName to find or create one; otherwise the client default is used. Poll the returned id with generate_get-generation.';
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
  const meta = profile.supportsAppUi
    ? tool.meta
    : Object.fromEntries(
        Object.entries(tool.meta ?? {}).filter(
          ([key]) => !key.startsWith('openai/') && key !== 'ui',
        ),
      );
  const presented = { ...tool, inputSchema, description, meta };
  return profile.supportsAppUi && WIDGET_CALLABLE_HOSTED_TOOLS.has(tool.name)
    ? exposeToolToWidget(presented)
    : presented;
}

// Schemas and stateless handlers belong to the factory, not each HTTP session.
// Authentication is resolved per request by createHttpClient; presentation stays local.
function createTools(
  config: SyncMcpConfig,
  operations: ReturnType<typeof parseSpec>,
  httpClient: ReturnType<typeof createHttpClient>,
  getProfile: () => ClientProfile,
  chatgptApp?: ChatgptApp,
): McpToolDefinition[] {
  // These operations require the durable wrapper's admission key and public projection.
  const generatedOperations = operations.filter(
    (operation) =>
      translationPreviewOperations([operation]).length === 0 &&
      !isPlatformImportOperation(operation) &&
      operation.studioDraftVersion !== 1 &&
      operation.studioViewVersion !== 1,
  );
  const generatedTools = generateTools(
    config.transport === 'http'
      ? generatedOperations.filter((operation) =>
          HOSTED_HTTP_TOOL_ALLOWLIST.has(operationIdToToolName(operation.operationId)),
        )
      : generatedOperations,
    httpClient,
  );
  const allTools = [
    ...(chatgptApp
      ? [
          createOpenSyncAppTool(
            chatgptApp,
            generatedTools.find((tool) => tool.name === 'projects_get-all'),
          ),
        ]
      : []),
    createUploadWidgetTool(),
    createAccountContextTool(
      httpClient,
      supportsStudioDrafts(operations),
      supportsStudioViews(operations),
      generatedTools.some((tool) => tool.name === 'voices_clone-voice'),
      ['voices_get-voice', 'voices_delete-voice'].every((name) =>
        generatedTools.some((tool) => tool.name === name),
      ),
      supportsPlatformImports(operations),
    ),
    ...createStudioViewTools(operations, httpClient),
    ...createStudioDraftTools(operations, httpClient),
    ...createGenerationFeedbackTools(httpClient),
    ...createPlatformImportTools(operations, httpClient),
    ...createAccountManagementTools(httpClient),
    createAssetCreatorsTool(httpClient),
    createPlaybackMetadataTool(httpClient),
    createGenerationContinuationTool(httpClient),
    ...createAppTools(httpClient, undefined, getProfile),
    ...createProjectHistoryTools(operations, httpClient),
    ...createTranslationTools(operations, httpClient),
    ...createTranslationPreviewTools(operations, httpClient),
    ...createDialogueTools(operations, httpClient),
    ...createSpeechTools(operations, httpClient),
    ...generatedTools.map((tool) =>
      config.chatgptApp?.uploadStorageOrigin
        ? relayUploadTool(tool, config.chatgptApp.domain, config.chatgptApp.uploadStorageOrigin)
        : tool,
    ),
  ];
  return config.transport === 'http'
    ? allTools.filter((tool) => HOSTED_HTTP_TOOL_ALLOWLIST.has(tool.name))
    : allTools;
}

function createProfiledServer(
  config: SyncMcpConfig,
  operations: ReturnType<typeof parseSpec>,
  authHeaders: Record<string, string> = {},
  chatgptApp?: ChatgptApp,
  previousApps: ChatgptApp[] = [],
  sharedCatalog?: {
    tools: McpToolDefinition[];
    descriptors: Map<ClientProfile['name'], Tool[]>;
  },
): McpServer {
  let profile: ClientProfile | undefined;
  let clientName: string | undefined;
  const getProfile = () => profile ?? resolveClientProfile();
  const httpClient = createHttpClient(
    config.baseUrl,
    authHeaders,
    config.transport === 'stdio' ? () => clientName : undefined,
  );
  const tools =
    sharedCatalog?.tools ?? createTools(config, operations, httpClient, getProfile, chatgptApp);
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
            if (APP_UI_TOOLS.has(tool.name) && !profile.supportsAppUi)
              throw new Error(
                'Open the Sync app in ChatGPT, or use the Sync tools in this client.',
              );
            if (
              !profile.supportsUploads &&
              (['upload-media', 'open-upload-widget'].includes(tool.name) ||
                (tool.name === 'create-lipsync' &&
                  ['video', 'image', 'audio'].some((key) => args[key] !== undefined)))
            ) {
              throw new Error(UNSUPPORTED_UPLOAD_MESSAGE);
            }
            return tool.handler(args, { ...parameters[1], clientProfile: profile });
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
  for (const [index, app] of (chatgptApp ? [chatgptApp, ...previousApps] : []).entries()) {
    if (index === 0) resources.push({ name: 'sync-app', uri: app.uri, ...app.metadata });
    server.registerResource(
      index === 0 ? 'sync-app' : `sync-app-previous-${index}`,
      app.uri,
      app.metadata,
      async () => {
        if (!getProfile().supportsAppUi)
          throw new Error('This interface requires an app-compatible client.');
        process.stderr.write(
          `${JSON.stringify({ event: 'app_resource_served', timestamp: new Date().toISOString(), clientName, resource: app.uri, bytes: Buffer.byteLength(app.html) })}\n`,
        );
        return {
          contents: [
            {
              uri: app.uri,
              mimeType: app.metadata.mimeType,
              text: app.html,
              _meta: app.metadata._meta,
            },
          ],
        };
      },
    );
  }
  let descriptors: Tool[] = [];
  server.server.setRequestHandler(ListToolsRequestSchema, () => {
    if (!profile) throw new Error('Complete MCP initialization before listing tools.');
    return { tools: descriptors };
  });
  server.server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: resources.filter((resource) =>
      resource.name === 'sync-app' ? getProfile().supportsAppUi : getProfile().supportsUploads,
    ),
  }));
  const onInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    if (!profile) {
      clientName = server.server.getClientVersion()?.name;
      const initializedProfile = resolveClientProfile(clientName);
      profile = initializedProfile;
      const cached = sharedCatalog?.descriptors.get(initializedProfile.name);
      if (cached) {
        descriptors = cached;
        onInitialized?.();
        return;
      }
      const visible =
        config.transport === 'http'
          ? selectHostedHttpTools(tools, initializedProfile)
          : tools
              .filter((tool) => isToolVisible(tool, initializedProfile))
              .map((tool) => presentTool(tool, initializedProfile));
      descriptors = visible.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: z.toJSONSchema(z.object(tool.inputSchema)) as Tool['inputSchema'],
        ...(tool.outputSchema
          ? {
              outputSchema: {
                type: 'object',
                anyOf: [z.toJSONSchema(z.object(tool.outputSchema)), toolErrorOutputSchema],
              } as Tool['outputSchema'],
            }
          : {}),
        annotations: tool.annotations,
        _meta: createToolDescriptorMeta(tool.meta),
      }));
      sharedCatalog?.descriptors.set(initializedProfile.name, descriptors);
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
  const [chatgptApp, ...previousApps] = await loadChatgptAppReleases(config.chatgptApp);
  return createProfiledServer(config, operations, authHeaders, chatgptApp, previousApps);
}

export async function createMcpServerFactory(
  config: SyncMcpConfig,
): Promise<{ createServer: () => McpServer; toolCount: number }> {
  const [chatgptApp, ...previousApps] = await loadChatgptAppReleases(config.chatgptApp);
  // Filter and build schemas once. Session profiles and SDK transports stay local.
  const operations = parseSpec(await fetchSpec(config.baseUrl)).filter(
    (operation) =>
      HOSTED_HTTP_TOOL_ALLOWLIST.has(operationIdToToolName(operation.operationId)) ||
      translationOperation([operation]) !== undefined ||
      translationPreviewOperations([operation]).length > 0 ||
      dialogueOperations([operation]).length > 0 ||
      speechOperations([operation]).length > 0 ||
      isPlatformImportOperation(operation) ||
      operation.studioDraftVersion === 1 ||
      operation.studioViewVersion === 1,
  );
  const tools = createTools(
    config,
    operations,
    createHttpClient(config.baseUrl),
    resolveClientProfile,
    chatgptApp,
  );

  // Four presentation profiles at most; never key this by untrusted client names.
  const sharedCatalog = { tools, descriptors: new Map<ClientProfile['name'], Tool[]>() };
  return {
    // Number registered across hosted profiles, not each client's visible catalog.
    toolCount: new Set(tools.map((tool) => tool.name)).size,
    createServer: () =>
      createProfiledServer(config, operations, {}, chatgptApp, previousApps, sharedCatalog),
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
