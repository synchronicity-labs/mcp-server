import type { McpServer, ResourceMetadata } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { McpToolDefinition } from './generator.js';

export const MCP_APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
export const UPLOAD_WIDGET_URI = 'ui://sync/upload-widget-v1.html';

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
      <p id="hint">Choose a ChatGPT file or upload a local image, video, or audio file.</p>
      <div class="actions">
        <button id="selectFile" class="primary" type="button">Choose from ChatGPT</button>
        <button id="uploadLocal" class="secondary" type="button">Upload local file</button>
        <input id="localFile" type="file" accept="image/*,video/*,audio/*" />
      </div>
      <div class="status" id="status" aria-live="polite">
        <strong>Ready</strong>
        <span>Waiting for media.</span>
      </div>
    </main>

    <script>
      (function () {
        var openai = window.openai;
        var input = (openai && openai.toolInput) || {};
        var requestedMediaType = typeof input.requestedMediaType === "string" ? input.requestedMediaType : "";
        var script = typeof input.script === "string" ? input.script : "";
        var state = (openai && openai.widgetState && typeof openai.widgetState === "object")
          ? openai.widgetState
          : {};

        var selectButton = document.getElementById("selectFile");
        var localButton = document.getElementById("uploadLocal");
        var localInput = document.getElementById("localFile");
        var status = document.getElementById("status");
        var hint = document.getElementById("hint");

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
        }

        function setBusy(isBusy) {
          selectButton.disabled = isBusy || !canSelectFiles();
          localButton.disabled = isBusy || !canUploadLocal();
        }

        function canSelectFiles() {
          return Boolean(openai && openai.selectFiles && openai.getFileDownloadUrl && openai.callTool);
        }

        function canUploadLocal() {
          return Boolean(openai && openai.uploadFile && openai.getFileDownloadUrl && openai.callTool);
        }

        function mediaTypeFrom(mimeType, fileName) {
          if (requestedMediaType === "image" || requestedMediaType === "video" || requestedMediaType === "audio") {
            return requestedMediaType;
          }
          var lowerMime = String(mimeType || "").toLowerCase();
          if (lowerMime.indexOf("image/") === 0) return "image";
          if (lowerMime.indexOf("video/") === 0) return "video";
          if (lowerMime.indexOf("audio/") === 0) return "audio";
          var lowerName = String(fileName || "").toLowerCase();
          if (/\\.(png|jpg|jpeg|webp|gif)$/.test(lowerName)) return "image";
          if (/\\.(mp4|mov|m4v|webm)$/.test(lowerName)) return "video";
          if (/\\.(mp3|wav|m4a|aac|ogg)$/.test(lowerName)) return "audio";
          return "video";
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

        function assetIdFrom(value) {
          if (!value || typeof value !== "object") return "";
          if (typeof value.assetId === "string") return value.assetId;
          if (typeof value.asset_id === "string") return value.asset_id;
          if (value.structuredContent) {
            var structuredAssetId = assetIdFrom(value.structuredContent);
            if (structuredAssetId) return structuredAssetId;
          }
          if (Array.isArray(value.content)) {
            for (var i = 0; i < value.content.length; i += 1) {
              var item = value.content[i];
              if (item && item.type === "text" && typeof item.text === "string") {
                var parsed = parseJson(item.text);
                var parsedAssetId = assetIdFrom(parsed);
                if (parsedAssetId) return parsedAssetId;
              }
            }
          }
          if (value.call_tool_result) return assetIdFrom(value.call_tool_result);
          if (value.mcp_tool_result) return assetIdFrom(value.mcp_tool_result);
          return "";
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
          var fileId = fileIdFrom(fileRef);
          var fileName = fileRef.fileName || fileRef.file_name || "chatgpt-upload";
          var mimeType = fileRef.mimeType || fileRef.mime_type || "";
          if (!fileId) {
            throw new Error("ChatGPT did not return a file id.");
          }

          var mediaType = mediaTypeFrom(mimeType, fileName);
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
            modelContent: modelContent,
            privateContent: {
              fileId: fileId,
              fileName: fileName,
              mimeType: mimeType,
            },
          };
          if (mediaType === "image") nextState.imageIds = [fileId];
          setStatus("Uploaded", assetField + " " + assetId, nextState);

          if (openai && typeof openai.sendFollowUpMessage === "function") {
            var prompt = script
              ? "Continue the Sync lipsync request using " + assetField + " " + assetId + " and script " + JSON.stringify(script) + ". Call voices_get-voices, choose a suitable voiceId, call create-lipsync, then poll generate_get-generation until COMPLETED and return outputUrl."
              : "The Sync upload is ready. mediaType: " + mediaType + "; assetId: " + assetId + ".";
            await openai.sendFollowUpMessage({ prompt: prompt, scrollToBottom: true });
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

        if (script) {
          hint.textContent = "Choose the media for: " + script;
        }
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

export function registerUploadWidgetResource(server: McpServer): void {
  server.registerResource(
    'sync-upload-widget',
    UPLOAD_WIDGET_URI,
    UPLOAD_WIDGET_RESOURCE_METADATA,
    async () => ({
      contents: [
        {
          uri: UPLOAD_WIDGET_URI,
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: UPLOAD_WIDGET_HTML,
          _meta: UPLOAD_WIDGET_RESOURCE_META,
        },
      ],
    }),
  );
}

export function createUploadWidgetTool(): McpToolDefinition {
  return {
    name: 'open-upload-widget',
    title: 'Open upload widget',
    description:
      'Open the Sync upload widget so a user can choose a ChatGPT file or upload a local image, video, or audio file, then stage it as a durable Sync assetId. Use this in ChatGPT before create-lipsync when the user uploads or wants to upload media.',
    inputSchema: {
      requestedMediaType: z
        .enum(['image', 'video', 'audio'])
        .describe('Optional media type expected from the user.')
        .optional(),
      script: z
        .string()
        .describe(
          'Optional text the selected image or video should say. The widget will return the assetId and ask ChatGPT to continue the lipsync flow.',
        )
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
        args.requestedMediaType === 'image' ||
        args.requestedMediaType === 'video' ||
        args.requestedMediaType === 'audio'
          ? args.requestedMediaType
          : undefined;
      const script = typeof args.script === 'string' ? args.script : undefined;

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
