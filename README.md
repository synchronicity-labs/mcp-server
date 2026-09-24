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
Claude and unknown clients expose `create-lipsync`, `voices_get-voices`, and
`generate_get-generation` for public/Sync-hosted URLs and existing Sync asset IDs.
Upload local media in authenticated Sync and use **Copy ID** in the same organization,
or **Copy URL**. Unsupported file/widget calls return this guidance without uploading.

Defaults are `ChatGPT generations`, `Claude generations`, or `Sync generations` for
unknown clients; explicit `projectName` wins. Muse remains an unknown client until its
actual handshake alias is verified. Client names affect presentation only, never
organization access or credit permissions. No Muse origin or attachment contract is assumed.

### Request cancellation

Explicit MCP request cancellation propagates to project lookup, upload admission,
file transfer, asset registration, generation submission, and generated API tools.
The server checks cancellation before starting another write. Sync API calls have
a 65-second deadline, allowing the supported 55-second generation long poll;
upload queueing and transfer retain their configured upload deadline.

Cancellation cannot undo a write already accepted by Sync. If submission times
out or is cancelled while in flight, acceptance may be unknown: do not blindly
retry a generation. Retrieve a known generation ID to check its status. Closing a
connection is not a promise that an accepted generation was cancelled, and this
server does not automatically send a generation-cancellation or refund request.
