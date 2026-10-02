# Sync MCP Server

An open-source [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for the [Sync](https://sync.so) API. Gives AI agents the ability to create lipsync videos, manage assets, check generation status, and more.

Tools are **auto-generated from the Sync OpenAPI spec** at startup. As new API endpoints ship, they become available to agents automatically — no server update needed.

## Supported Clients

| Client | Status | Transport |
|--------|--------|-----------|
| [Claude Web](https://claude.ai) (claude.ai) | Supported | Remote (HTTP + OAuth) |
| [Claude Desktop](https://claude.ai/download) | Supported | Local (stdio) |
| [ChatGPT Desktop](https://openai.com/chatgpt/desktop/) | Supported | Local (stdio) |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Supported | Local (stdio) |
| [Cursor](https://cursor.com) | Supported | Local (stdio) |
| [Windsurf](https://codeium.com/windsurf) | Supported | Local (stdio) |
| [Codex CLI](https://github.com/openai/codex) | Supported | Local (stdio) |
| Any MCP-compatible client | Supported | Local (stdio) |

## Quick Start

### Claude Web (claude.ai)

No installation required — connect directly from your browser.

1. Go to [claude.ai](https://claude.ai) → **Settings** → **Integrations**
2. Click **Add custom connector**
3. Enter **Name:** `Sync` and **URL:** `https://mcp.sync.so/mcp`
4. Click **Add**, then **Connect**
5. Log in with your Sync account when prompted

No API key needed — authentication is handled via OAuth.

### Claude Code

```bash
claude mcp add sync -- npx -y @sync.so/mcp-server --api-key YOUR_API_KEY
```

Or add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "sync": {
      "command": "npx",
      "args": ["-y", "@sync.so/mcp-server"],
      "env": {
        "SYNC_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sync": {
      "command": "npx",
      "args": ["-y", "@sync.so/mcp-server"],
      "env": {
        "SYNC_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "sync": {
      "command": "npx",
      "args": ["-y", "@sync.so/mcp-server"],
      "env": {
        "SYNC_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Without an API key (interactive login)

Omit `SYNC_API_KEY` and the server will start a device auth flow on first run:

```json
{
  "mcpServers": {
    "sync": {
      "command": "npx",
      "args": ["-y", "@sync.so/mcp-server"]
    }
  }
}
```

You'll be prompted to visit a URL and enter a code. After approval, the token is cached at `~/.config/sync/mcp-credentials.json`.

## Getting an API Key

1. Sign up at [sync.so](https://sync.so)
2. Go to your dashboard settings
3. Generate an API key

See the [authentication guide](https://sync.so/docs/api-reference/guides/authentication) for details.

## Available Tools

Tools are dynamically generated from the Sync API. Core tools include:

| Tool | Description |
|------|-------------|
| `models_get` | List available lipsync models |
| `generate_create-generation` | Create a lipsync video from video + audio inputs |
| `generate_get-generation` | Get generation status — poll until COMPLETED |
| `generate_get-generations` | List recent generations |
| `generate_estimate-cost` | Estimate generation cost before creating |
| `generations_get-by-id` | Get a generation by ID |
| `generations_delete` | Delete a generation |
| `assets_create-upload-url` | Get a presigned URL to upload a local file |
| `assets_create` | Register a media URL as a reusable asset |
| `assets_get-all` | List all assets in your organization |
| `assets_get` | Get a specific asset by ID |
| `assets_update` / `assets_delete` | Update or delete an asset |
| `voices_get-voices` | List premade + cloned voices |
| `voices_clone-voice` | Clone a voice from an audio/video sample |
| `voices_delete-voice` | Delete a cloned voice |
| `tts_create` | Synthesize speech from text → audio URL |
| `projects_create` | Create a project to group generations + assets |
| `projects_get-all` / `projects_get` | List / get projects |
| `projects_update` / `projects_delete` | Update or delete a project |

## Example Prompts

Once configured, ask your AI agent:

- *"List available Sync models"*
- *"Create a lipsync video with this video URL and audio URL using the lipsync-2 model"*
- *"Check the status of generation gen-abc123"*
- *"Show me my recent generations"*
- *"How much would it cost to generate a 30-second video?"*

## CLI Options

```
Usage: sync-mcp [options]

Options:
  --api-key <key>     API key (or set SYNC_API_KEY env var)
  --base-url <url>    API base URL (default: https://api.sync.so)
  --transport <type>  stdio (default) or http
  --port <port>       HTTP port (default: 3002, only with --transport http)
  -h, --help          Show this help message
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SYNC_API_KEY` | Your Sync API key (stdio transport) | — |
| `SYNC_BASE_URL` | API base URL | `https://api.sync.so` |
| `SYNC_CHATGPT_APP_DIR` | Directory containing the approved frontend's `app.html` and `manifest.json`; unset keeps the new app unavailable | unset |
| `SYNC_CHATGPT_APP_PREVIOUS_DIRS` | JSON array of up to eight retained immutable frontend directories for cached clients | `[]` |
| `SYNC_CHATGPT_APP_CONNECT_DOMAINS` | JSON array of exact HTTPS origins for uploads and media extraction | `[]` |
| `SYNC_APP_UPLOAD_ORIGINS` | JSON array of exact HTTPS browser origins allowed to upload | widget domain and `https://web-sandbox.oaiusercontent.com` |
| `SYNC_APP_UPLOAD_STORAGE_ORIGIN` | Exact HTTPS storage origin allowed for the one-use upload relay; unset uses direct presigned uploads | unset |
| `SYNC_CHATGPT_APP_DOMAIN` | Exact HTTPS widget origin for the configured app | required when app is configured |
| `SYNC_CHATGPT_APP_RESOURCE_DOMAINS` | JSON array of exact HTTPS origins used for media playback | `[]` |
| `MCP_ISSUER_URL` | OAuth issuer URL (HTTP transport only) | — |
| `OAUTH_REGISTRATION_SECRET` | Shared secret for client registration (HTTP transport only) | — |
| `MCP_SESSION_IDLE_TTL_MS` | Idle time before an inactive HTTP session is closed | `1800000` (30 min) |
| `MCP_MAX_SESSIONS` | Maximum active and initializing HTTP sessions | `1000` |
| `MCP_SESSION_SWEEP_INTERVAL_MS` | Interval for idle-session cleanup | `60000` (1 min) |
| `MCP_SHUTDOWN_GRACE_MS` | Time to drain active requests before forced shutdown cleanup | `10000` (10 sec) |
| `MCP_RUNTIME_TELEMETRY_INTERVAL_MS` | Interval for structured memory, CPU, event-loop, session, request, and upload telemetry | `15000` (15 sec) |
| `MCP_UPLOAD_MAX_BYTES` | Maximum declared or streamed size for a re-hosted upload | `536870912` (512 MiB) |
| `MCP_UPLOAD_CONCURRENCY` | Maximum concurrent re-host uploads per process | `2` |
| `MCP_UPLOAD_MAX_QUEUED` | Maximum re-host uploads waiting for process capacity | `8` |
| `MCP_UPLOAD_RETRY_AFTER_MS` | Suggested retry delay returned by upload overload errors | `5000` (5 sec) |
| `MCP_UPLOAD_TIMEOUT_MS` | End-to-end deadline for a queued or active re-host upload | `900000` (15 min) |

HTTP session limits apply only to the stateful remote transport. Sessions with requests in flight are protected from idle expiry. When capacity is exhausted, new session initialization returns `503` with `Retry-After`; existing sessions continue normally.

Re-hosted uploads are streamed through bounded temporary files before durable asset registration. The deployment needs writable temporary disk sized for `MCP_UPLOAD_MAX_BYTES * MCP_UPLOAD_CONCURRENCY`; a memory-backed temporary directory defeats the memory bound. When upload capacity is exhausted, excess work fails with the retryable `UPLOAD_CAPACITY_EXCEEDED` code instead of increasing process memory pressure.

The HTTP server writes newline-delimited JSON diagnostics to stderr. Lifecycle events distinguish graceful pod termination from abrupt process loss, request logs include latency and abort state, and `mcp_runtime` heartbeats include memory, CPU, event-loop delay, session totals, pending transports, aggregate HTTP status counts, and upload activity, queue, rejection, and byte counters.

## How It Works

1. On startup, the server fetches the OpenAPI spec from `{baseUrl}/api-json`
2. Parses all public endpoints into operation definitions
3. Converts each operation into an MCP tool with a Zod input schema
4. Registers tools on the MCP server
5. Each tool call makes an authenticated HTTP request to the Sync API

This means **new API endpoints are automatically available** — just restart the MCP server.

## Programmatic Usage

You can also use the server as a library:

```typescript
import { createSyncMcpServer, resolveConfig } from '@sync.so/mcp-server';

const config = resolveConfig({ apiKey: 'your-key' });
const server = await createSyncMcpServer(config);
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint

# Type check
npm run typecheck
```

### Local HTTP Transport Testing

To test the HTTP transport (OAuth flow) locally:

1. Copy `.env.example` to `.env` and fill in the values
2. Start a tunnel to expose localhost:
   ```bash
   ngrok http 3002
   ```
3. Update `MCP_ISSUER_URL` in `.env` with the ngrok URL
4. Start the server:
   ```bash
   source .env
   node dist/cli.js --transport http --base-url $SYNC_BASE_URL --port 3002
   ```
5. Verify it works:
   ```bash
   curl https://<ngrok-url>/health
   curl https://<ngrok-url>/.well-known/oauth-authorization-server
   ```
6. Add `https://<ngrok-url>/mcp` as a custom connector in [Claude Web](https://claude.ai)

## Learn More

- [Claude directory readiness](docs/claude-directory-readiness.md) — Review checklist and remaining submission work
- [Sync Documentation](https://sync.so/docs) — Full API reference and guides
- [Sync API Reference](https://sync.so/docs/api-reference) — Endpoint documentation
- [MCP Protocol](https://modelcontextprotocol.io) — Learn about the Model Context Protocol
- [Sync Website](https://sync.so) — Sign up and get started

## License

MIT

### Hosted client compatibility

Hosted sessions select one immutable presentation profile after MCP initialization.
Exact ChatGPT aliases retain the upload widget, file metadata and optional file arguments.
All hosted clients can discover models (`models_get`), search/list and read projects
(`projects_get-all`, `projects_get`), search/list and read assets (`assets_get-all`,
`assets_get`), list organization generation history (`generate_get-generations`),
and estimate cost (`generate_estimate-cost`). These tools use the API's OpenAPI
contracts and the caller's existing Sync permissions. Lists retain the API cursor
parameters. ChatGPT can also call these tools from its UI.

When the backend advertises project filtering, `projects_get-generations` provides
history for one required canonical `projectId`, with the same cursor and limit
parameters as the public API. It verifies project access before reading history
and rejects responses containing another project's records, including responses
from an older API instance during a rolling deployment. The organization-feed
tool remains available on older backends. Deploy the compatible backend to every
instance, then restart MCP to refresh its OpenAPI catalog before enabling project
history in the app. This does not create a second plugin or a mirrored database.

Claude and unknown clients also expose `create-lipsync`, `voices_get-voices`, and
`generate_get-generation` for public/Sync-hosted URLs and existing Sync asset IDs.
Upload local media in authenticated Sync and use **Copy ID** in the same organization,
or **Copy URL**. Unsupported file/widget calls return this guidance without uploading.

Defaults are `ChatGPT generations`, `Claude generations`, or `Sync generations` for
unknown clients. Supply `projectId` to select an existing project by its canonical ID,
or `projectName` to find or create a named project. These fields are mutually exclusive.
An explicit project ID is checked for access before any file transfer; an inaccessible
or deleted project fails without falling back to a new project. Muse remains an unknown client until its
actual handshake alias is verified. Client names affect presentation only, never
organization access or credit permissions. No Muse origin or attachment contract is assumed.

### Request cancellation

Explicit MCP request cancellation propagates to project lookup, upload admission,
file transfer, asset registration, generation submission, and generated API tools.
The server checks cancellation before starting another write. Tool API calls have
a 65-second transport deadline; generation polling uses the API default wait window;
upload queueing and transfer retain their configured upload deadline.

Cancellation cannot undo a write already accepted by Sync. If submission times
out or is cancelled while in flight, acceptance may be unknown: do not blindly
retry a generation. Retrieve a known generation ID to check its status. Closing a
connection is not a promise that an accepted generation was cancelled, and this
server does not automatically send a generation-cancellation or refund request.

### OAuth proxy lifecycle and release verification

Token exchange and revocation responses are marked `Cache-Control: no-store` and
`Pragma: no-cache`. Their upstream requests have a ten-second deadline covering
headers and body consumption, return a sanitized 504 on timeout, and are aborted
when the caller disconnects. No exchange is automatically retried. Access-token
verification separately retains its five-second deadline.

Startup reports `registeredToolCount`, the number of available tools registered
across hosted profiles; each client's visible catalog can be smaller. Hosted API
operations are filtered once before per-session schema construction.

See [release verification](docs/release-verification.md) for reproducible checks,
component provenance, and the distinction between controlled tests and live Muse
review readiness.


### Recovering a generation submission

`create-lipsync` accepts an optional `idempotencyKey` and forwards it as the
existing Sync API's `Idempotency-Key` header. Clients should persist a key for
one intentional generation action and reuse the same key and payload after an
ambiguous response. A new intentional generation uses a new key. The backend
owns replay, conflict detection and credit accounting; MCP does not retry writes.

Use the explicit canonical `projectId` and durable asset IDs or stable URLs for
keyed submissions. Stage ChatGPT files with `upload-media` first, then use the
returned asset IDs. Re-transferring transient file inputs can produce different
asset IDs and a changed-payload conflict. Keys accept 1-128 ASCII letters,
digits, periods, underscores, tildes and hyphens. Omitting the key preserves
existing behavior.

An `IDEMPOTENCY_OUTCOME_UNKNOWN` error may contain a UUID `generationId`.
MCP preserves that ID in `structuredContent.error`; clients should retain it
and use `generate_get-generation` for status reads instead of creating again.

### Embedded Sync app

Build `@sync/chatgpt` in the Sync monorepo and supply its `app.html` and
`manifest.json` together in `SYNC_CHATGPT_APP_DIR`. The server verifies the
manifest format, HTML SHA256, UTF-8 and size (8 MiB maximum) at factory startup.
Each session serves those same loaded bytes under a content-addressed resource
URI. Invalid configured artifacts fail startup rather than silently serving a
different interface. These checks establish artifact consistency; deployment
must still obtain the bundle from the approved frontend build.

The `open-sync-app` tool exposes the resource through the standard MCP Apps UI
metadata and declares ChatGPT global/sidebar and thread/panel entrypoints.
Opening it is read-only. Existing uploads and tool-only clients are preserved;
the new tool and resource are only presented to the ChatGPT client profile.
HTTP authentication still applies to the MCP connection.

The resource requests camera and microphone access through MCP Apps
`ui.permissions` for user-initiated recording. The host must delegate those
permissions and the user must grant browser access. A declaration alone does
not prove capture works in ChatGPT; verify with the paired recording UI release.
Both CSP metadata formats include `blob:` for local recording review before upload.
Configured network resource and connection origins still require exact HTTPS
origins; the local scheme is not added to connection or frame permissions.

Set the widget origin and the exact media origins for the target environment.
Browser API connections are not allowed by this UI resource's CSP; backend
operations go through the authenticated MCP bridge. The frontend remains
disabled unless its directory is explicitly configured. The production container
includes the pinned frontend under `/app/chatgpt-dist/<HTML SHA256>`. Docker
verifies the bundle with the same manifest loader used by the server before
copying it into the final image. See [frontend release packaging](docs/chatgpt-release.md)
for provenance, activation settings, retention, and rollback. Real
ChatGPT/account acceptance remains a separate release requirement.

Local example after building the frontend and this server:

```sh
SYNC_CHATGPT_APP_DIR=/absolute/path/to/sync-api-v2/apps/chatgpt/dist \
SYNC_CHATGPT_APP_DOMAIN=https://your-verified-widget-origin.example \
SYNC_CHATGPT_APP_RESOURCE_DOMAINS='["https://your-media-origin.example"]' \
node dist/cli.js --transport http --port 3002
```

### Embedded upload and authentication behavior

The optional upload relay issues a random, single-use ticket only after an authenticated
presign request. It checks exact content type and size, expires after at most five minutes,
and streams only to the configured HTTPS storage origin under the existing upload runtime
concurrency and timeout limits. Browser relay uploads support the API single-PUT
maximum of 5 GiB; the 512 MiB download limit still applies to rehosting ChatGPT
attachments. Legacy presign responses without an expiry receive a five-minute ticket.
Tickets are process-local: the MCP session and its upload must reach the same instance.
A restart invalidates outstanding tickets; the client can request a new upload. Multi-instance
release routing must account for this before enabling the relay in production. The widget
origin must also route `/app-upload` to that instance and appear in connect domains.

OAuth verification reuses successful results for at most 15 seconds and never beyond
token expiry. Concurrent checks are deduplicated; successful revocation clears this
provider's cache. Revocation elsewhere can take up to 15 seconds to affect this cache.
Userinfo rate limits trigger token-specific backoff capped at 15 seconds, rather
than blocking unrelated accounts or treating temporary errors as invalid tokens.

`npm run test:browser` verifies an 11 MB browser upload through the real relay to fixture
storage. Install Chromium with `npx playwright install chromium` first. This does not
prove live authenticated storage delivery or authorize a production rollout.
