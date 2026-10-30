# sync. MCP server

Connect your AI agent to [sync.](https://sync.so) to lip-sync videos, translate
and dub them into other languages, clone voices, and manage assets and projects
from a chat or a coding session.

sync. hosts this server at **`https://mcp.sync.so/mcp`**. You sign in with your
sync. account, so there is nothing to install and no API key to copy. Every merge
to this repository's `main` deploys there.

## Connect your agent

### ChatGPT

Open [sync. in ChatGPT](https://chatgpt.com/plugins/plugin_asdk_app_6a398355fbc08191a232e7eeeacb73d5)
and connect your account. In ChatGPT, sync. Studio also opens inside the chat.

### Claude (claude.ai and Claude Desktop)

1. Open **Settings → Connectors** and choose **Add custom connector**.
2. Name it `sync.` and set the URL to `https://mcp.sync.so/mcp`.
3. Click **Connect** and sign in to sync.

### Claude Code

```bash
claude mcp add --transport http sync https://mcp.sync.so/mcp
```

Then run `/mcp` in Claude Code, select `sync` and sign in. Add `--scope user` to
use it in every project.

### Codex

```bash
codex mcp add sync --url https://mcp.sync.so/mcp
codex mcp login sync
```

### Cursor

Add to `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for all projects:

```json
{
  "mcpServers": {
    "sync": { "url": "https://mcp.sync.so/mcp" }
  }
}
```

Cursor asks you to sign in to sync. the first time it connects.

### VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "sync": { "type": "http", "url": "https://mcp.sync.so/mcp" }
  }
}
```

### Other clients

Any client that supports remote MCP servers over Streamable HTTP with OAuth can
use `https://mcp.sync.so/mcp`. The client registers itself, and you sign in to
sync. in the browser.

### Local server with an API key

For clients without remote MCP support, and for scripts and CI, run the server
locally over stdio with a sync. [API key](https://sync.so/docs/api-reference/guides/authentication):

```bash
claude mcp add sync -e SYNC_API_KEY=your-api-key -- npx -y @sync.so/mcp-server
```

Or in a client's JSON config:

```json
{
  "mcpServers": {
    "sync": {
      "command": "npx",
      "args": ["-y", "@sync.so/mcp-server"],
      "env": { "SYNC_API_KEY": "your-api-key" }
    }
  }
}
```

Without `SYNC_API_KEY`, the server starts a device login on first run: visit the
URL it prints and enter the code. The token is cached at
`~/.config/sync/mcp-credentials.json`.

npm releases are published separately from the hosted deploy and can lag behind
it, so prefer the hosted server when your client supports it.

## What to ask

Paste prompts like these into your agent. Asset IDs come from your sync. library.
Links can be public media URLs or YouTube, TikTok, Instagram and Facebook videos.

| Ask | What the agent does |
| --- | --- |
| "Lipsync video asset `<video-asset-id>` with audio asset `<audio-asset-id>`." | `create-lipsync` with the saved assets, then waits for the result |
| "Lipsync https://example.com/talk.mp4 to https://example.com/voiceover.wav." | `create-lipsync` with public URLs |
| "Translate https://www.youtube.com/watch?v=… to Spanish." | Imports the link with `assets_create`, quotes the cost, and after you confirm runs `create-translate-and-dub` |
| "Make video asset `<video-asset-id>` say “thanks for watching” in a calm narrator voice." | Picks a voice with `voices_get-voices`, quotes the script, then `create-lipsync` with `script` |
| "How many credits do I have left?" | `get-account-usage` |
| "What did my last generation cost?" | Finds it in history and reads `get-generation-costs` |

Translation, dubbing, speech previews and voice clones are quoted and confirmed
with you before they start.

## Tools

The hosted server exposes a curated set of tools to every client:

| Area | Tools |
| --- | --- |
| Lip sync | `create-lipsync`, `generate_estimate-cost`, `generate_get-generation`, `generate_get-generations`, `get-generation-continuation`, `get-generation-costs`, `models_get` |
| Translation and dubbing | `create-translate-and-dub`, `get-translation-options`, `estimate-translation-preview`, `create-translation-preview`, `get-translation-preview` |
| Speech and voices | `create-speech-preview`, `get-speech-options`, `get-speech-preview`, `voices_get-voices`, `voices_clone-voice` |
| Edit Dialogue | `get-dialogue-options`, `upload-dialogue-source`, `create-dialogue-transcription`, `get-dialogue-transcription`, `create-dialogue-preview`, `get-dialogue-preview`, `estimate-dialogue-video`, `create-dialogue-video` |
| Assets | `assets_create`, `assets_create-upload-url`, `assets_get`, `assets_get-all`, `assets_count`, `assets_get-download-url`, `assets_update`, `assets_delete`, `get-playback-metadata`, `get-audio-trim`, `trim-audio` |
| Projects | `projects_create`, `projects_get`, `projects_get-all`, `projects_get-generations`, `rename-project` |
| Account | `get-account-context`, `get-account-usage` |

ChatGPT also gets the tools behind the embedded Studio app: Studio views and
drafts, the upload widget and app helpers. Other clients don't see them, and
calls to them from other clients are refused.

The local stdio server has all of these, plus a tool for every other public API
operation in the [OpenAPI spec](https://api.sync.so/api-json), such as
`projects_delete` and `voices_delete-voice`.

[Tool workflows](docs/tool-workflows.md) describes how the multi-step and paid
tools behave.

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

Environment variables and the HTTP server's session, memory, upload and
diagnostics limits are in [HTTP server configuration](docs/http-server.md).

## How It Works

1. At startup, the server fetches the public OpenAPI spec from `{baseUrl}/api-json`
   and turns each operation into an MCP tool with a Zod input schema.
2. Hand-written tools add multi-step workflows on the same API, such as translate
   and dub, Edit Dialogue, speech previews and cost lookups.
3. Each tool call is an authenticated request to the sync. API, with your OAuth
   token (hosted) or API key (local).

Over stdio, a new public API operation becomes a tool on the next restart. The
hosted server only exposes tools on its allowlist, so a new hosted tool ships with
a release of this repository.

## Programmatic Usage

You can also use the server as a library:

```typescript
import { createSyncMcpServer, resolveConfig } from '@sync.so/mcp-server';

const config = resolveConfig({ apiKey: 'your-key' });
const server = await createSyncMcpServer(config);
```

## Development

HTTPS source tests use the local `openssl` command to create a one-day, self-signed
test identity. Temporary certificate and key files are removed before the tests run.

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Run tests
pnpm test

# Lint
pnpm run lint

# Type check
pnpm run typecheck

# Script tests (monitor, smoke check, pre-commit size check)
pnpm run test:scripts
```

Development needs Node 22.22.1 or newer (`.nvmrc`); `devEngines` in `package.json`
enforces it on install. `pnpm install` installs a pre-commit hook. It runs Oxlint and Oxfmt on staged
files, and blocks a staged source file that grows past 5,000 tokens (20,000
bytes). Files already over that size are exempt until someone splits them.

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
When an isolated Studio login requires the same-origin web proxy, set
`SYNC_OAUTH_AUTHORIZATION_URL` to its `/api-proxy/v2/oauth/authorize` URL, while
keeping `SYNC_BASE_URL` on the direct isolated API listener. Only browser
navigation uses the web proxy. Registration, code exchange, refresh, revocation,
userinfo and tool calls use the direct API and retain existing deadlines,
PKCE and confidential-client checks. The optional URL must use HTTP(S), with no
credentials, query or fragment. Existing deployments need no new setting.

6. Add `https://<ngrok-url>/mcp` as a custom connector in [Claude Web](https://claude.ai)

## Learn More

- [Tool workflows](docs/tool-workflows.md) — How multi-step and paid tools behave
- [HTTP server configuration](docs/http-server.md) — Environment variables and runtime limits
- [Maintainer notes](docs/maintainers.md) — Hosted compatibility, cancellation, OAuth proxy, uploads and monitoring
- [Claude directory readiness](docs/claude-directory-readiness.md) — Review checklist and remaining submission work
- [Sync Documentation](https://sync.so/docs) — Full API reference and guides
- [Sync API Reference](https://sync.so/docs/api-reference) — Endpoint documentation
- [MCP Protocol](https://modelcontextprotocol.io) — Learn about the Model Context Protocol
- [Sync Website](https://sync.so) — Sign up and get started

## License

MIT
