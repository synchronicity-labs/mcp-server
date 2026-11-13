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

The server is listed in the [official MCP Registry](https://registry.modelcontextprotocol.io)
as `io.github.synchronicity-labs/mcp-server`, so clients and directories that read
the registry can find and add it. `server.json` is that listing.

### Local server with an API key

For clients without remote MCP support, and for scripts and CI, run the server
locally over stdio with a sync. [API key](https://sync.so/docs/api-reference/guides/authentication):

```bash
claude mcp add sync -e SYNC_API_KEY=your-api-key -- npx -y @sync.so/mcp-server@latest
```

Or in a client's JSON config:

```json
{
  "mcpServers": {
    "sync": {
      "command": "npx",
      "args": ["-y", "@sync.so/mcp-server@latest"],
      "env": { "SYNC_API_KEY": "your-api-key" }
    }
  }
}
```

Without `SYNC_API_KEY`, the server starts a device login on first run: visit the
URL it prints and enter the code. The token is cached at
`~/.config/sync/mcp-credentials.json`.

npm releases are published separately from the hosted deploy and can lag behind
it, so prefer the hosted server when your client supports it. `@latest` makes npx
fetch the newest release when the client restarts the server; without it, npx can
keep running an old cached copy.

#### Update notice

At startup a local server asks the npm registry for the latest version, at most once
a day (the answer is cached in `~/.config/sync/mcp-update-check.json`). The check runs
in the background with a two-second limit and never delays startup or a tool call; if
it fails, nothing is shown. When a newer version exists, the server's instructions and
the first tool result of the session tell the agent to ask you to restart with
`npx -y @sync.so/mcp-server@latest` or switch to the hosted server.

To turn it off, set `SYNC_MCP_UPDATE_CHECK=off` or pass `--no-update-check`. It is
also skipped when `CI` is set, and the hosted server never checks.

#### Usage telemetry

The server tells sync. when a session starts and, for each tool call, which tool ran,
whether it worked and how long it took, so we can see which tools people rely on and
where agents get stuck. It sends these to the sync. API you already use, signed with
your own API key or login, a few seconds apart and never in the way of a call.

It records the shape of a call, never its content: a model or language you chose, but
only the length of a script, and only the kind of a link (YouTube, Sync storage or
`other`), never the link. It never sends prompts, scripts, file names, URLs, media,
error messages or your key. [docs/telemetry.md](docs/telemetry.md) lists every field.

Directories can optionally supply `X-MCP-Referral` on hosted initialization or
`SYNC_MCP_REFERRAL` for the npm package. When supplied and supported by the API,
this self-reported source is included in usage events. See
[directory referrals](docs/telemetry.md#directory-referrals) for the format and limits.

To turn it off, set `SYNC_MCP_TELEMETRY=off` or `DO_NOT_TRACK=1`, or pass
`--no-telemetry`.

## What to ask

Paste prompts like these into your agent. Asset IDs come from your sync. library.
Links can be public media URLs or YouTube, TikTok, Instagram and Facebook videos.

| Ask | What the agent does |
| --- | --- |
| "Lipsync video asset `<video-asset-id>` with audio asset `<audio-asset-id>`." | `lipsync_create` with the saved assets, then waits for the result |
| "Lipsync https://example.com/talk.mp4 to https://example.com/voiceover.wav." | `lipsync_create` with public URLs |
| "Translate https://www.youtube.com/watch?v=… to Spanish." | Imports the link with `assets_create`, quotes the cost, and after you confirm runs `dubbing_create` |
| "Make video asset `<video-asset-id>` say “thanks for watching” in a calm narrator voice." | Picks a voice with `voices_list`, quotes the script, then `lipsync_create` with `script` |
| "How many credits do I have left?" | `account_get-usage` |
| "Upgrade us to Pro." | `billing-approval-links_create`, then gives you the sync.so link to approve and pay |
| "What did my last generation cost?" | Finds it in history and reads `generations_get-costs` |

Translation, dubbing, speech previews and voice clones are quoted and confirmed
with you before they start.

### Agent skills

Step-by-step workflows for these tools (lipsync, talking photos, dubbing, Edit Dialogue,
campaigns, batches, troubleshooting and the API) are agent skills in
[synchronicity-labs/skills](https://github.com/synchronicity-labs/skills). Install them
in any agent with `npx skills add synchronicity-labs/skills`. The ChatGPT and Codex
plugin ships them from a pinned commit of that repository; see
[docs/chatgpt-plugin.md](docs/chatgpt-plugin.md).

## Tools

The hosted server exposes a curated set of tools to every client:

| Area | Tools |
| --- | --- |
| Lip sync | `lipsync_create`, `lipsync_create-timeline`¹, `generations_estimate-cost`, `generations_get`, `generations_list`, `generations_get-continuation`, `generations_get-costs`, `models_list` |
| Translation and dubbing | `dubbing_create`, `dubbing_get-options`, `translation-previews_estimate`, `translation-previews_create`, `translation-previews_get` |
| Speech and voices | `speech-previews_create`, `speech-previews_get-options`, `speech-previews_get`, `voices_list`, `voices_clone` |
| Edit Dialogue | `dialogue_get-options`, `dialogue_upload-source`, `dialogue-transcriptions_create`, `dialogue-transcriptions_get`, `dialogue-previews_create`, `dialogue-previews_get`, `dialogue-videos_estimate`, `dialogue-videos_create` |
| Assets | `assets_create`, `assets_create-upload-url`, `assets_get`, `assets_list`, `assets_count`, `assets_get-download-url`, `assets_update`, `assets_delete`, `assets_get-playback-metadata`, `audio-trims_get`, `audio-trims_create` |
| Projects | `projects_create`, `projects_get`, `projects_list`, `projects_list-generations`, `projects_rename` |
| Many jobs | `jobs_create-many`², `jobs_get-many`² |
| Batches | `batches_create`², `batches_get`², `batches_list`² |
| Account | `account_get-context`, `account_get-usage`, `organizations_list`, `organizations_select`, `billing-approval-links_create`³ |

¹ Not offered to the ChatGPT app, whose embedded Studio has no timeline.

² Not in the ChatGPT app listing yet. `jobs_create-many` starts up to 50 independent jobs
at once, such as one video dubbed into several languages, by running one create tool
(`lipsync_create`, `dubbing_create`, `dialogue-videos_create` and others) once per item,
with the same API, limits and billing as single calls on any plan; `jobs_get-many` follows
the set. See [Jobs](docs/jobs.md#many-jobs-at-once). A batch is the API's separate queued
pipeline for large runs (20 to 500 generations) on Scale plans and above that can wait
hours. Where the account's plan doesn't include batch, the API answers 402 with
`requiredPlan` and `billingUrl`, which the tools pass on.

³ Not in the ChatGPT app listing yet, and listed only when the API publishes
`POST /v2/billing/approval-links`. It returns a sync.so link where a person approves and
pays for a plan or credits; creating it charges nothing. See
[Billing refusals and approval links](docs/tool-workflows.md#billing-refusals-and-approval-links).

Organizations with the matching feature also get `scenes_detect` (camera cuts in a
video) and `stems_separate` (vocals and background audio), outside the ChatGPT
app. They are in the `lipsync` and `assets` toolsets locally. The same goes for
`faces_detect`, `faces_get` and `faces_get-timeline` (faces, shots and who talks in a
video) and the `shots` input of `lipsync_create`, in the `lipsync` toolset, and for
its `speakers` input (several people, each to their own audio, in one generation); see
[Lipsync planning](docs/lipsync-planning.md).

Clients with app support also get the tools behind the embedded Studio app:
Studio views and drafts, the upload widget and app helpers. Those are clients
whose MCP handshake name selects the ChatGPT or Codex app profile (`openai-mcp`,
`openai-mcp (Codex)`; see `src/client-profile.ts`). Other clients don't see these
tools, and their calls to them are refused.

### Local toolsets

The local stdio server can also offer a tool for every other public API operation in
the [OpenAPI spec](https://api.sync.so/api-json), 65+ in all. By default it lists the
hosted set above, without its admin tools (`assets_delete` and `voices_clone`),
plus `jobs_get`, `jobs_wait` and the `transcriptions_*` tools, whose speaker face
tracks feed `lipsync_create-timeline` clips.

To list more, set `SYNC_MCP_TOOLSETS` or pass `--toolsets` with a comma-separated list:

| Toolset | Adds |
| --- | --- |
| `default` | The default above, so `default,admin` adds the admin tools to it |
| `lipsync` | Lip sync, timeline, Edit Dialogue, audio trim and batch tools, plus raw `generate_*`, `generations_*` and `dialogue-edits_*` |
| `dubbing` | Translation and dubbing tools, and the batch tools |
| `assets` | `assets_*` (except deletes) and the upload tools |
| `projects` | `projects_*` (except deletes) and `projects_rename` |
| `transcription` | `transcriptions_*` |
| `voices` | `voices_*` (except cloning and deletes), speech previews and `tts_*` |
| `admin` | Every delete (`assets_delete`, `projects_delete`, `generations_delete`, `voices_delete`) and `voices_clone` |
| `all` | Every tool, as before this option existed |

Job, account and generation reads (`jobs_get`, `jobs_wait`, `jobs_get-many`,
`generations_get`, `account_get-context`, `organizations_list`, `organizations_select` and
similar) come with every selection, as does `jobs_create-many` whenever a create tool it
runs is listed. Naming toolsets replaces
the default rather than adding to it. To get every tool back:

```bash
claude mcp add sync -e SYNC_API_KEY=your-api-key -e SYNC_MCP_TOOLSETS=all -- npx -y @sync.so/mcp-server@latest
```

Unless it lists everything, the server's instructions tell the agent which toolsets are
listed and how to get the rest, so it can ask you to restart the server with a wider
set. The hosted server ignores this setting.

[Tool workflows](docs/tool-workflows.md) describes how the multi-step and paid
tools behave.

Tool names follow one `<noun>_<verb>` scheme (`lipsync_create`, `generations_get`).
The names used before it (`create-lipsync`, `generate_get-generation`) still work for a
deprecation period: calls through them run the same tool and add a one-line notice
naming the new one. [Tool names](docs/tool-names.md) has the full old → new table.

## CLI Options

```
Usage: sync-mcp [options]

Options:
  --api-key <key>     API key (or set SYNC_API_KEY env var)
  --base-url <url>    API base URL (default: https://api.sync.so)
  --transport <type>  stdio (default) or http
  --port <port>       HTTP port (default: 3002, only with --transport http)
  --no-spend-confirmation
                      Unattended automation: drop the cost-quote and confirm-before-paying
                      instructions (or set SYNC_MCP_SPEND_CONFIRMATION=off)
  --no-update-check   Skip the daily npm check for a newer version (or set
                      SYNC_MCP_UPDATE_CHECK=off; skipped when CI is set)
  --toolsets <list>   stdio only: comma-separated tools to list (or set SYNC_MCP_TOOLSETS):
                      default, lipsync, dubbing, assets, projects, transcription,
                      voices, admin or all (default: the hosted set without admin)
  -h, --help          Show this help message
```

### Unattended automation

By default the tools tell the agent to quote a paid action and wait for the user's
approval. When the server runs a pipeline or a scheduled agent whose operator has already
approved spending, start it with `--no-spend-confirmation` (or
`SYNC_MCP_SPEND_CONFIRMATION=off`). The agent then creates jobs without quoting or asking,
and estimate tools stay available. Agents cannot change this setting.

Job tools take `wait: true` to wait on the server (up to about 50 seconds per call, with
progress notifications when the client sends a `progressToken`): `generations_get`,
`translation-previews_get`, `transcriptions_get` and social imports
through `assets_create`. On the local server, `jobs_wait` and `jobs_get` do the same for
every kind of job (generation, transcription, speaker analysis, translation preview,
import) with one input, `{kind, id, projectId?}`, and one result shape and status set;
see [Jobs](docs/jobs.md). `jobs_get-many` reads up to 50 jobs that way at once, on both
servers.

When the API offers it, `feedback_send` lets agents report confusing errors, wrong results
and missing capabilities to the Sync team.

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

Development needs Node 26 or newer (`.nvmrc`); `devEngines` in `package.json`
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
- [Lipsync planning](docs/lipsync-planning.md) — Face analysis tools and shot input, for organizations with the feature
- [HTTP server configuration](docs/http-server.md) — Environment variables and runtime limits
- [Maintainer notes](docs/maintainers.md) — Hosted compatibility, cancellation, OAuth proxy, uploads and monitoring
- [Claude directory readiness](docs/claude-directory-readiness.md) — Review checklist and remaining submission work
- [Sync Documentation](https://sync.so/docs) — Full API reference and guides
- [Sync API Reference](https://sync.so/docs/api-reference) — Endpoint documentation
- [MCP Protocol](https://modelcontextprotocol.io) — Learn about the Model Context Protocol
- [Sync Website](https://sync.so) — Sign up and get started

## License

MIT
