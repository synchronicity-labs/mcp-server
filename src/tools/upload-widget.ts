import type {
  ReadResourceCallback,
  ResourceMetadata,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { McpToolDefinition } from './generator.js';

export const MCP_APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
export const UPLOAD_WIDGET_URI = 'ui://sync/upload-widget-v7.html';
export const UPLOAD_WIDGET_LEGACY_URIS = [
  'ui://sync/upload-widget-v1.html',
  'ui://sync/upload-widget-v2.html',
  'ui://sync/upload-widget-v3.html',
  'ui://sync/upload-widget-v4.html',
  'ui://sync/upload-widget-v5.html',
  'ui://sync/upload-widget-v6.html',
] as const;

const UPLOAD_WIDGET_RESOURCE_URIS = [UPLOAD_WIDGET_URI, ...UPLOAD_WIDGET_LEGACY_URIS] as const;

type UploadWidgetResourceServer = {
  registerResource(
    name: string,
    uri: string,
    metadata: ResourceMetadata,
    readCallback: ReadResourceCallback,
  ): unknown;
};

const UPLOAD_WIDGET_DESCRIPTION =
  'Select or upload media inside ChatGPT, stage it as a durable Sync asset, and report the assetId back into the conversation.';

const UPLOAD_WIDGET_RESOURCE_META: Record<string, unknown> = {
  ui: {
    prefersBorder: true,
    csp: {
      connectDomains: [],
      resourceDomains: [],
    },
  },
  'openai/widgetDescription': UPLOAD_WIDGET_DESCRIPTION,
  'openai/widgetPrefersBorder': true,
  'openai/widgetCSP': {
    connect_domains: [],
    resource_domains: [],
  },
};

const UPLOAD_WIDGET_RESOURCE_METADATA: ResourceMetadata = {
  title: 'Sync uploader',
  description: UPLOAD_WIDGET_DESCRIPTION,
  mimeType: MCP_APP_RESOURCE_MIME_TYPE,
  _meta: UPLOAD_WIDGET_RESOURCE_META,
};

export const UPLOAD_WIDGET_HTML = `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: #ffffff;
        --fg: #141414;
        --muted: #666666;
        --line: #d9d9d9;
        --button-bg: #141414;
        --button-fg: #ffffff;
        --secondary-bg: #f4f4f4;
        --secondary-fg: #171717;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #171717;
          --fg: #f4f4f4;
          --muted: #adadad;
          --line: #3a3a3a;
          --button-bg: #f4f4f4;
          --button-fg: #171717;
          --secondary-bg: #262626;
          --secondary-fg: #f4f4f4;
        }
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      main {
        display: grid;
        gap: 12px;
        padding: 16px;
        max-width: 520px;
      }

      h1 {
        margin: 0;
        font-size: 16px;
        font-weight: 650;
        letter-spacing: 0;
      }

      p {
        margin: 0;
        color: var(--muted);
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .script-field {
        display: grid;
        gap: 6px;
      }

      .script-field span {
        color: var(--muted);
        font-size: 12px;
        font-weight: 650;
      }

      input[type="text"] {
        min-height: 36px;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 0 10px;
        background: transparent;
        color: var(--fg);
        font: inherit;
      }

      button {
        min-height: 36px;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 0 12px;
        font: inherit;
        cursor: pointer;
      }

      button.primary {
        background: var(--button-bg);
        border-color: var(--button-bg);
        color: var(--button-fg);
      }

      button.secondary {
        background: var(--secondary-bg);
        color: var(--secondary-fg);
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }

      .status {
        min-height: 44px;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 10px 12px;
        overflow-wrap: anywhere;
      }

      .status strong {
        display: block;
        margin-bottom: 2px;
      }

      code {
        font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }

      input[type="file"] {
        display: none;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Upload to Sync</h1>
      <p id="hint">Choose a ChatGPT file or upload a local image or audio file. Attach videos in chat first.</p>
      <label class="script-field" for="scriptInput">
        <span>Script</span>
        <input id="scriptInput" type="text" autocomplete="off" placeholder="Text for the image to say" />
      </label>
      <div class="actions">
        <button id="selectFile" class="primary" type="button">Choose from ChatGPT</button>
        <button id="uploadLocal" class="secondary" type="button">Upload local file</button>
        <button id="runLipsync" class="secondary" type="button">Run lipsync</button>
        <input id="localFile" type="file" accept="image/*,audio/*" />
      </div>
      <div class="status" id="status" aria-live="polite">
        <strong>Ready</strong>
        <span>Waiting for media.</span>
      </div>
    </main>

    <script>
      (function () {
        var openai = window.openai;
        function bridgeObject(value) {
          return value && typeof value === "object" && !Array.isArray(value) ? value : {};
        }

        function bridgeStructuredContent(sourceOpenai) {
          var metadata = bridgeObject(sourceOpenai && sourceOpenai.toolResponseMetadata);
          var callToolResult = bridgeObject(metadata.call_tool_result);
          var mcpToolResult = bridgeObject(metadata.mcp_tool_result);
          return Object.assign(
            {},
            bridgeObject(mcpToolResult._meta),
            bridgeObject(callToolResult._meta),
            bridgeObject(mcpToolResult.structuredContent),
            bridgeObject(callToolResult.structuredContent)
          );
        }

        function bridgeInputFrom(sourceOpenai) {
          return Object.assign(
            {},
            bridgeStructuredContent(sourceOpenai),
            bridgeObject(sourceOpenai && sourceOpenai.toolOutput),
            bridgeObject(sourceOpenai && sourceOpenai.toolInput)
          );
        }

        var input = bridgeInputFrom(openai);
        var requestedMediaType = typeof input.requestedMediaType === "string" ? input.requestedMediaType : "";
        var script = typeof input.script === "string" ? input.script : "";
        var state = (openai && openai.widgetState && typeof openai.widgetState === "object")
          ? openai.widgetState
          : {};

        var selectButton = document.getElementById("selectFile");
        var localButton = document.getElementById("uploadLocal");
        var runButton = document.getElementById("runLipsync");
        var localInput = document.getElementById("localFile");
        var scriptInput = document.getElementById("scriptInput");
        var status = document.getElementById("status");
        var hint = document.getElementById("hint");
        var isBusy = false;

        function updateHint() {
          if (script) {
            hint.textContent = requestedMediaType
              ? "Choose the " + requestedMediaType + " for: " + script
              : "Choose the media for: " + script;
          } else {
            hint.textContent = "Choose a ChatGPT file or upload a local image or audio file. Attach videos in chat first.";
          }
          if (openai && typeof openai.notifyIntrinsicHeight === "function") {
            openai.notifyIntrinsicHeight();
          }
        }

        function syncScriptInput() {
          var nextScript = scriptInput.value.trim();
          if (script === nextScript) {
            updateRunButton();
            return;
          }
          script = nextScript;
          state = Object.assign({}, state, { script: script || undefined });
          if (openai && typeof openai.setWidgetState === "function") {
            openai.setWidgetState(state);
          }
          updateHint();
          updateRunButton();
        }

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }

        function setStatus(title, detail, patch) {
          state = Object.assign({}, state, patch || {}, {
            statusTitle: title,
            statusDetail: detail,
          });
          if (openai && typeof openai.setWidgetState === "function") {
            openai.setWidgetState(state);
          }
          status.innerHTML = "<strong>" + escapeHtml(title) + "</strong><span>" + escapeHtml(detail) + "</span>";
          if (openai && typeof openai.notifyIntrinsicHeight === "function") {
            openai.notifyIntrinsicHeight();
          }
          updateRunButton();
        }

        function setBusy(nextBusy) {
          isBusy = nextBusy;
          selectButton.disabled = isBusy || !canSelectFiles();
          localButton.disabled = isBusy || !canUploadLocal();
          updateRunButton();
        }

        function canSelectFiles() {
          return Boolean(openai && openai.selectFiles && openai.getFileDownloadUrl && openai.callTool);
        }

        function canUploadLocal() {
          return Boolean(openai && openai.uploadFile && openai.getFileDownloadUrl && openai.callTool);
        }

        function canRunLipsync() {
          return Boolean(
            openai &&
              openai.callTool &&
              script &&
              state.assetId &&
              state.mediaType === "image" &&
              !state.generationId &&
              !state.lipsyncStarted
          );
        }

        function updateRunButton() {
          runButton.disabled = isBusy || !canRunLipsync();
        }

        function applyBridgeInput(nextInput) {
          var nextMediaType = typeof nextInput.requestedMediaType === "string" ? nextInput.requestedMediaType : "";
          var nextScript = typeof nextInput.script === "string" ? nextInput.script : "";
          var changed = false;

          if (
            (nextMediaType === "image" || nextMediaType === "audio") &&
            requestedMediaType !== nextMediaType
          ) {
            requestedMediaType = nextMediaType;
            changed = true;
          }
          if (nextScript && script !== nextScript) {
            script = nextScript;
            scriptInput.value = script;
            changed = true;
          }

          if (changed) {
            updateHint();
            maybeRunPendingLipsync();
          }
        }

        function syncBridgeInput(sourceOpenai) {
          applyBridgeInput(bridgeInputFrom(sourceOpenai || openai));
        }

        function globalsFromEvent(event) {
          return bridgeObject(event && event.detail && event.detail.globals);
        }

        function maybeRunPendingLipsync() {
          if (!script || !state.assetId || state.mediaType !== "image") return;
          if (state.generationId || state.lipsyncStarted || state.statusTitle !== "Uploaded") return;
          state = Object.assign({}, state, { lipsyncStarted: true });
          if (openai && typeof openai.setWidgetState === "function") {
            openai.setWidgetState(state);
          }
          void runLipsyncFlow(state.assetId, state.mediaType).catch(function (error) {
            setStatus("Lipsync failed", error && error.message ? error.message : String(error), {
              lipsyncStarted: false,
            });
          });
        }

        function mediaTypeFrom(mimeType, fileName) {
          if (requestedMediaType === "image" || requestedMediaType === "audio") {
            return requestedMediaType;
          }
          var lowerMime = String(mimeType || "").toLowerCase();
          if (lowerMime.indexOf("image/") === 0) return "image";
          if (lowerMime.indexOf("audio/") === 0) return "audio";
          var lowerName = String(fileName || "").toLowerCase();
          if (/\\.(png|jpg|jpeg|webp|gif)$/.test(lowerName)) return "image";
          if (/\\.(mp3|wav|m4a|aac|ogg)$/.test(lowerName)) return "audio";
          return "";
        }

        function fileIdFrom(value) {
          if (typeof value === "string") return value;
          if (!value || typeof value !== "object") return "";
          return value.fileId || value.file_id || value.id || "";
        }

        function downloadUrlFrom(value) {
          if (typeof value === "string") return value;
          if (!value || typeof value !== "object") return "";
          return value.downloadUrl || value.download_url || value.url || value.href || "";
        }

        function parseJson(text) {
          try {
            return JSON.parse(text);
          } catch (_error) {
            return null;
          }
        }

        function payloadFromToolResult(value) {
          if (!value || typeof value !== "object") return value;
          if (value.structuredContent) return value.structuredContent;
          if (value.call_tool_result) return payloadFromToolResult(value.call_tool_result);
          if (value.mcp_tool_result) return payloadFromToolResult(value.mcp_tool_result);
          if (Array.isArray(value.content)) {
            for (var i = 0; i < value.content.length; i += 1) {
              var item = value.content[i];
              if (item && item.type === "text" && typeof item.text === "string") {
                var parsed = parseJson(item.text);
                if (parsed) return parsed;
              }
            }
          }
          return value;
        }

        function findStringByKeys(value, keys, depth) {
          if (!value || typeof value !== "object" || depth > 8) return "";
          for (var i = 0; i < keys.length; i += 1) {
            var direct = value[keys[i]];
            if (typeof direct === "string" && direct) return direct;
          }
          if (Array.isArray(value)) {
            for (var a = 0; a < value.length; a += 1) {
              var fromArray = findStringByKeys(value[a], keys, depth + 1);
              if (fromArray) return fromArray;
            }
            return "";
          }
          var objectKeys = Object.keys(value);
          for (var k = 0; k < objectKeys.length; k += 1) {
            var fromObject = findStringByKeys(value[objectKeys[k]], keys, depth + 1);
            if (fromObject) return fromObject;
          }
          return "";
        }

        function assetIdFrom(value) {
          return findStringByKeys(payloadFromToolResult(value), ["assetId", "asset_id"], 0);
        }

        function generationIdFrom(value) {
          return findStringByKeys(payloadFromToolResult(value), ["id", "generationId", "generation_id"], 0);
        }

        function generationStatusFrom(value) {
          return findStringByKeys(payloadFromToolResult(value), ["status", "state"], 0);
        }

        function outputUrlFrom(value) {
          return findStringByKeys(payloadFromToolResult(value), ["outputUrl", "output_url"], 0);
        }

        function voiceFromToolResult(value) {
          return findVoice(payloadFromToolResult(value), 0);
        }

        function findVoice(value, depth) {
          if (!value || typeof value !== "object" || depth > 8) return null;
          if (Array.isArray(value)) {
            for (var i = 0; i < value.length; i += 1) {
              var fromArray = findVoice(value[i], depth + 1);
              if (fromArray) return fromArray;
            }
            return null;
          }
          if (typeof value.id === "string" && value.id) {
            return {
              id: value.id,
              name: typeof value.name === "string" ? value.name : value.id,
            };
          }
          var preferred = ["voices", "data", "items", "results"];
          for (var p = 0; p < preferred.length; p += 1) {
            var fromPreferred = findVoice(value[preferred[p]], depth + 1);
            if (fromPreferred) return fromPreferred;
          }
          var keys = Object.keys(value);
          for (var k = 0; k < keys.length; k += 1) {
            var fromObject = findVoice(value[keys[k]], depth + 1);
            if (fromObject) return fromObject;
          }
          return null;
        }

        function delay(ms) {
          return new Promise(function (resolve) {
            setTimeout(resolve, ms);
          });
        }

        async function runLipsyncFlow(assetId, mediaType) {
          if (!script || mediaType !== "image") return;

          state = Object.assign({}, state, { lipsyncStarted: true });
          if (openai && typeof openai.setWidgetState === "function") {
            openai.setWidgetState(state);
          }
          setStatus("Choosing voice", "Finding an available Sync voice.", {
            assetId: assetId,
            mediaType: mediaType,
            script: script,
            lipsyncStarted: true,
          });
          var voicesResult = await openai.callTool("voices_get-voices", {});
          var voice = voiceFromToolResult(voicesResult);
          if (!voice || !voice.id) {
            throw new Error("No Sync voice id was returned.");
          }

          setStatus("Creating lipsync", voice.name || voice.id, {
            assetId: assetId,
            mediaType: mediaType,
            script: script,
            voiceId: voice.id,
            lipsyncStarted: true,
          });
          var createArgs = { imageAssetId: assetId, script: script, voiceId: voice.id };
          var createResult = await openai.callTool("create-lipsync", createArgs);
          var generationId = generationIdFrom(createResult);
          if (!generationId) {
            throw new Error("Sync did not return a generation id.");
          }

          for (var attempt = 1; attempt <= 60; attempt += 1) {
            setStatus("Generating", "Polling " + generationId + " (" + attempt + "/60)", {
              assetId: assetId,
              mediaType: mediaType,
              script: script,
              voiceId: voice.id,
              generationId: generationId,
              lipsyncStarted: true,
            });
            var generation = await openai.callTool("generate_get-generation", { id: generationId });
            var statusText = generationStatusFrom(generation).toUpperCase();
            var outputUrl = outputUrlFrom(generation);
            if (statusText === "COMPLETED" || outputUrl) {
              setStatus("Completed", outputUrl || generationId, {
                assetId: assetId,
                mediaType: mediaType,
                script: script,
                voiceId: voice.id,
                generationId: generationId,
                outputUrl: outputUrl,
                lipsyncStarted: true,
                modelContent:
                  "Sync lipsync completed. generationId: " +
                  generationId +
                  (outputUrl ? "; outputUrl: " + outputUrl : ""),
              });
              return;
            }
            if (statusText === "FAILED" || statusText === "CANCELED" || statusText === "CANCELLED") {
              throw new Error("Sync generation " + generationId + " ended with status " + statusText + ".");
            }
            await delay(5000);
          }

          throw new Error("Timed out polling Sync generation.");
        }

        async function getDownloadUrl(fileId) {
          var response = await openai.getFileDownloadUrl({ fileId: fileId });
          var downloadUrl = downloadUrlFrom(response);
          if (!downloadUrl) {
            throw new Error("ChatGPT did not return a download URL for the selected file.");
          }
          return downloadUrl;
        }

        async function uploadToSync(fileRef) {
          syncScriptInput();
          var fileId = fileIdFrom(fileRef);
          var fileName = fileRef.fileName || fileRef.file_name || "chatgpt-upload";
          var mimeType = fileRef.mimeType || fileRef.mime_type || "";
          if (!fileId) {
            throw new Error("ChatGPT did not return a file id.");
          }

          var mediaType = mediaTypeFrom(mimeType, fileName);
          if (!mediaType) {
            throw new Error(
              "The upload widget supports images and audio only. Attach videos in the ChatGPT composer, then ask Sync to create the lipsync."
            );
          }
          setStatus("Preparing file", fileName, { fileId: fileId, fileName: fileName, mediaType: mediaType });
          var downloadUrl = await getDownloadUrl(fileId);
          setStatus("Uploading to Sync", fileName, { fileId: fileId, fileName: fileName, mediaType: mediaType });

          var result = await openai.callTool("upload-media", {
            mediaType: mediaType,
            file: {
              download_url: downloadUrl,
              file_id: fileId,
              mime_type: mimeType || undefined,
              file_name: fileName,
            },
          });
          var assetId = assetIdFrom(result);
          if (!assetId) {
            throw new Error("Sync upload finished without an assetId.");
          }

          var assetField = mediaType + "AssetId";
          var modelContent = "Uploaded " + mediaType + " to Sync. " + assetField + ": " + assetId + ".";
          var nextState = {
            fileId: fileId,
            fileName: fileName,
            mimeType: mimeType,
            mediaType: mediaType,
            assetId: assetId,
            assetField: assetField,
            lipsyncStarted: false,
            modelContent: modelContent,
            privateContent: {
              fileId: fileId,
              fileName: fileName,
              mimeType: mimeType,
            },
          };
          if (mediaType === "image") nextState.imageIds = [fileId];
          setStatus("Uploaded", assetField + " " + assetId, nextState);

          await runLipsyncFlow(assetId, mediaType);
        }

        async function runUploadedLipsync() {
          syncScriptInput();
          if (!script) {
            setStatus("Script required", "Enter text for the image to say.");
            return;
          }
          if (!state.assetId || state.mediaType !== "image") {
            setStatus("Upload media first", "Choose or upload an image before running lipsync.");
            return;
          }

          try {
            setBusy(true);
            await runLipsyncFlow(state.assetId, state.mediaType);
          } catch (error) {
            setStatus("Lipsync failed", error && error.message ? error.message : String(error), {
              lipsyncStarted: false,
            });
          } finally {
            setBusy(false);
          }
        }

        async function chooseFromChatGpt() {
          if (!canSelectFiles()) {
            setStatus("Unavailable", "ChatGPT file selection is not available in this session.");
            return;
          }
          try {
            setBusy(true);
            setStatus("Choosing file", "Open the ChatGPT file picker.");
            var files = await openai.selectFiles();
            if (!files || files.length === 0) {
              setStatus("Ready", "No file selected.");
              return;
            }
            await uploadToSync(files[0]);
          } catch (error) {
            setStatus("Upload failed", error && error.message ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }

        async function uploadLocalFile(file) {
          if (!canUploadLocal()) {
            setStatus("Unavailable", "Local upload is not available in this session.");
            return;
          }
          try {
            setBusy(true);
            setStatus("Uploading to ChatGPT", file.name);
            var response = await openai.uploadFile(file, { library: true });
            var fileId = fileIdFrom(response);
            if (!fileId) {
              throw new Error("ChatGPT did not return a file id.");
            }
            await uploadToSync({
              fileId: fileId,
              fileName: file.name,
              mimeType: file.type,
            });
          } catch (error) {
            setStatus("Upload failed", error && error.message ? error.message : String(error));
          } finally {
            localInput.value = "";
            setBusy(false);
          }
        }

        selectButton.addEventListener("click", chooseFromChatGpt);
        localButton.addEventListener("click", function () {
          localInput.click();
        });
        localInput.addEventListener("change", function (event) {
          var file = event.target.files && event.target.files[0];
          if (file) void uploadLocalFile(file);
        });
        scriptInput.addEventListener("input", syncScriptInput);
        runButton.addEventListener("click", runUploadedLipsync);
        window.addEventListener("openai:set_globals", function (event) {
          openai = window.openai || openai;
          syncBridgeInput(Object.assign({}, bridgeObject(openai), globalsFromEvent(event)));
        });

        scriptInput.value = script;
        syncBridgeInput(openai);
        updateHint();
        if (!openai) {
          setStatus("Unavailable", "Open this widget inside ChatGPT.");
        } else {
          setStatus(state.statusTitle || "Ready", state.statusDetail || "Waiting for media.", state);
        }
        setBusy(false);
      })();
    </script>
  </body>
</html>
`.trim();

export function registerUploadWidgetResource(server: UploadWidgetResourceServer): void {
  for (const uri of UPLOAD_WIDGET_RESOURCE_URIS) {
    const version = uri.match(/upload-widget-(v\d+)\.html$/)?.[1] ?? 'current';
    server.registerResource(
      `sync-upload-widget-${version}`,
      uri,
      UPLOAD_WIDGET_RESOURCE_METADATA,
      async (requestedUri) => ({
        contents: [
          {
            uri: requestedUri.toString(),
            mimeType: MCP_APP_RESOURCE_MIME_TYPE,
            text: UPLOAD_WIDGET_HTML,
            _meta: UPLOAD_WIDGET_RESOURCE_META,
          },
        ],
      }),
    );
  }
}

export function createUploadWidgetTool(): McpToolDefinition {
  return {
    name: 'open-upload-widget',
    title: 'Open image/audio upload widget',
    description:
      'Open the Sync image/audio upload widget so a user can choose a ChatGPT file or upload a supported local image/audio file, then stage it as a durable Sync assetId. Use this by default when the user wants to upload or choose a local image/audio file and has not attached the file to ChatGPT yet. For image-to-speech requests, call this with requestedMediaType: "image" and tell the user to enter the exact requested text in the widget Script field. This widget cannot accept video or MP4 files. Never use, recommend, or describe this tool for local video requests, and never use requestedMediaType: "video". For local video or MP4, ask the user to attach the video to the ChatGPT composer, then call upload-media or create-lipsync with file params.',
    inputSchema: {
      requestedMediaType: z
        .enum(['image', 'audio'])
        .describe('Optional image or audio media type expected from the user. Video is invalid.')
        .optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    meta: {
      ui: { resourceUri: UPLOAD_WIDGET_URI, visibility: ['model', 'app'] },
      'openai/outputTemplate': UPLOAD_WIDGET_URI,
      'openai/widgetAccessible': true,
      'openai/toolInvocation/invoking': 'Opening Sync uploader...',
      'openai/toolInvocation/invoked': 'Sync uploader ready.',
    },
    resultFormat: 'mcp',
    handler: async (args): Promise<CallToolResult> => {
      const requestedMediaType =
        args.requestedMediaType === 'image' || args.requestedMediaType === 'audio'
          ? args.requestedMediaType
          : undefined;
      const script = undefined;

      return {
        structuredContent: {
          requestedMediaType,
          script,
        },
        content: [
          {
            type: 'text',
            text: 'Sync uploader opened. Select media in the widget; it will return a durable Sync assetId.',
          },
        ],
        _meta: {
          requestedMediaType,
          script,
        },
      };
    },
  };
}
