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
| `create-translate-and-dub` | Translate and lip-sync a saved video in one generation, when supported by the API contract |
| `generations_get-by-id` | Get a generation by ID |
| `generations_delete` | Delete a generation |
| `assets_create-upload-url` | Get a presigned URL to upload a local file |
| `assets_create` | Register a media URL as a reusable asset |
| `assets_get-all` / `assets_count` | List and count assets with authenticated project, creator, search and type filters |
| `get-asset-creators` | Read creator labels for the connected organization without accepting an organization override |
| `get-generation-continuation` | Read a generation’s source, public settings, segments and dialogue lineage through the existing Studio API after fresh project and source access checks; never starts work |
| `get-playback-metadata` | Read user-authorized timing, dimensions and playback proxy metadata; API-key identity stays unsupported and missing metadata stays unknown |
| `assets_get` | Get a specific asset by ID |
| `assets_update` / `assets_delete` | Update or delete an asset |
| `voices_get-voices` | List premade + cloned voices |
| `voices_clone-voice` | Clone a voice from an audio/video sample |
| `voices_delete-voice` | Delete a cloned voice |
| `tts_create` | Synthesize speech from text → audio URL |
| `projects_create` | Create a project to group generations + assets |
| `projects_get-all` / `projects_get` | List / get projects |
| `projects_update` / `projects_delete` | Update or delete a project |
| `get-studio-view` | Read the exact mounted Studio view and its action receipt |
| `open-studio-project` | Open an existing project and optional workflow in Studio |
| `refresh-studio-project` | Refresh Studio after a project rename or details change |
| `refresh-studio-assets` | Refresh Studio after uploads or asset registration |
| `show-studio-generation` | Display an already accepted generation or result |
| `continue-studio-generation` | Stage an explicit source/output continuation in a new draft; archives the prior draft and may register existing output as media |
| `get-studio-draft` / `update-studio-draft` | Read or replace specified draft selections/settings with revision checks; updates are marked destructive |

`create-translate-and-dub` requires a saved video asset, accessible project,
model, target language and persistent idempotency key. Confirm the paid action
before calling it, then poll its generation ID through completion. The current
`generate_estimate-cost` response covers lip-sync only, not additional dubbing
charges. See the [workflow integration and release plan](docs/chatgpt-workflows.md)
for the remaining combined-pricing and embedded UI work.

### Edit Dialogue

When the API exposes transcription and dialogue-edit endpoints, `get-dialogue-options`
enables the embedded timed-word editor. When transcription refuses a source URL
because it is not in Sync storage, `upload-dialogue-source` copies the accessible
saved video through the bounded upload pipeline and returns a new project asset.
Use that asset's ID for the remaining dialogue calls. The widget performs this
recovery when `get-dialogue-options` advertises `sourceUpload: true`, and retains
the uploaded selection through reload, preview, and generation. Other 422 errors
do not initiate an upload, and a rejected uploaded copy does not trigger another
automatic upload. `create-dialogue-transcription` and
`get-dialogue-transcription` obtain the single-speaker transcript. Users edit or
remove timed words, then explicitly request `create-dialogue-preview` and poll
`get-dialogue-preview`. The adapter reads the server-owned transcript and keeps
the original speaker voice. It does not accept a full replacement script or a
selected TTS voice.

`estimate-dialogue-video` and `create-dialogue-video` use the completed preview's
`dialogueEdit.id`, original video asset and project. The final generation retains
normal API admission, retiming, billing and idempotency. A lost preview creation
response must not be automatically retried. Reopening an identified preview is
read-only. Partial completion must be shown to the user.

This candidate adds authenticated chat delivery to the exact mounted Studio view
from [sync-api-v2 #7227](https://github.com/synchronicity-labs/sync-api-v2/pull/7227).
Backend success is separate from its pending/applied/blocked/failed display
receipt. Existing draft synchronization and paid-operation recovery remain in
place; these view tools do not generate or synthesize media.
Each model-callable view operation has its own tool, flat input schema and
annotations. The generic `request-studio-view-action` tool is no longer exposed.
Draft updates/saves, project/workflow switches, result selection and continuation
declare destructive effects; receipt
acknowledgements remain non-destructive. Cached Studio resources retain the
existing app-only registration and acknowledgement tools.

This candidate includes thumbnail-only asset previews and hosted-video recovery
for Edit Dialogue. It packages the merged expanded-Studio fixes from
[sync-api-v2 #7216](https://github.com/synchronicity-labs/sync-api-v2/pull/7216),
[#7220](https://github.com/synchronicity-labs/sync-api-v2/pull/7220) and
[#7222](https://github.com/synchronicity-labs/sync-api-v2/pull/7222) and
[#7233](https://github.com/synchronicity-labs/sync-api-v2/pull/7233): active draft
context publication, fullscreen height, draft/result controls and accessible
current-result navigation. The release follow-up
[#7253](https://github.com/synchronicity-labs/sync-api-v2/pull/7253) aligns all
workflow titles, removes the projects-header Resume shortcut, and keeps previews
above the composer. New lipsync/image-to-video requests default to `sync-3`;
saved drafts and retries retain explicit model choices. It retains all eleven UI resources published through
MCP #96 and the unchanged archive of the oldest October 2 resource. See
[frontend packaging](docs/chatgpt-release.md) for the exact source commit,
checksums, release order and live acceptance requirements.

The existing workflow backend from PR #6822 is already in production. The draft
API is already published; the new Studio view API routes must be released before this MCP candidate.
Preparing the candidate does not deploy it or perform an EKS cutover.

## Example Prompts

### Embedded speech previews

When the API advertises durable `/v2/tts/jobs` creation and status endpoints,
ChatGPT can check `get-speech-options`, create a confirmed `create-speech-preview`
and read the same job with `get-speech-preview`. Creation requires a persisted
UUID idempotency key and is potentially paid. Reuse the key and identical input
only to reconcile uncertain admission. Never synthesize again because saving the
resulting audio asset failed. Project access and organization billing remain API
authority; options expose only the fields needed for the speech quote.

The compatible backend from sync-api-v2 PR #6822 is already in production.
The packaged frontend comes from the merged source recorded in its release
provenance. The candidate catalog retains eleven previous UIs; the retired October 2
resource is archived rather than served, as detailed in the release guide.
After the MCP release, rescan publisher metadata and verify preview, attachment,
reload recovery and playback in ChatGPT. Local and package checks do not establish
production acceptance; older APIs omit the speech tools and the UI fails closed.

### Embedded translation previews

With saved-asset support deployed on the existing `/v2/integrations/dubbing` API,
the server exposes
`estimate-translation-preview`, `create-translation-preview` and
`get-translation-preview`. These are separate from combined video dubbing.
Creation requires a stable UUID key and an authorized saved audio asset; the API
binds the key to immutable inputs before provider admission. A lost response
reuses the same key or known job ID. `recoveryRequired` never permits a fresh
paid request. Save/reconcile the resulting audio separately, then explicitly
lip-sync that saved audio rather than submitting another combined dub.

The API advertises versioned saved-source authorization and keyed recovery in
its OpenAPI contract. Existing route presence alone does not enable these tools.
Older APIs omit these tools; `get-translation-options.previewAvailable` reports
that distinction. Deploy API support before MCP, package the matching shared
Studio frontend, rescan, and verify the real ChatGPT workflow. Local fixtures
establish neither production release nor provider output quality.

`get-account-usage` reads the connected organization's billing projection and,
for metered accounts, complete current-period usage. Available credits exclude
in-flight holds. Missing usage is unavailable, never a zero total. Billing
management requires an owner/admin role as well as the API billing flag.
`rename-project` changes only the name through the existing authenticated project
PATCH route; it cannot change visibility or submit work and never retries writes
automatically. Embedded clients keep the title read-only when older MCP
releases omit `get-account-context.capabilities.projectRenaming`.

`get-account-context` reads `/v2/oauth/account` for the connected account and
organization. API keys retain a null signed-in account. The UI must not infer a
personal asset scope or permissions from a client name or an API key's owner.

### Reusable voice cloning in ChatGPT

When the connected API exposes voice cloning, hosted clients can call
`voices_clone-voice`. Ask: “Save a reusable clone of my voice from this sample,
called My narration.” Confirm permission to clone the speaker, the sample and
the name before creating it. Plan limits and provider requirements still apply.

1. Upload an audio/video sample in Sync, or upload and register it with the asset
   tools. Reuse its `assetId`; alternatively provide a Sync-hosted `url`.
2. List existing voices first to avoid unnecessary duplicates. Clone with
   `name`, `provider: elevenlabs` and exactly one sample source.
3. Use the returned **`id`** as `voiceId` in `create-lipsync` with `script`.
   The separate provider-specific `voiceId` field is not the Sync identifier.
4. Review the video estimate and confirm generation separately.

This exposes the conversational tool flow, not a new clone form in the embedded
UI. It does not enable hosted voice deletion or standalone TTS. Edit Dialogue's
original-speaker previews remain a different workflow.

The API enforces sample validity, asset access, plan slots, provider access and
duplicate names. On a failed or lost response, do not automatically retry:
list voices, reconcile the result and explain uncertainty to the user. See
[voice-cloning acceptance](docs/chatgpt-voice-cloning.md) before publication.

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
| `SYNC_BASE_URL` | Direct API base URL for server-side calls, including token exchange | `https://api.sync.so` |
| `SYNC_OAUTH_AUTHORIZATION_URL` | Optional browser-only authorization endpoint when Studio login uses another origin | `<SYNC_BASE_URL>/v2/oauth/authorize` |
| `SYNC_CHATGPT_APP_RELEASES` | Release manifest selecting the current and retained UI bundles; set by the Docker image, no per-release Porter edit | `/app/chatgpt-dist/releases.json` in Docker; otherwise unset |
| `SYNC_CHATGPT_APP_DIR` | Legacy/local frontend directory; packaged deployments select the release manifest instead | unset |
| `SYNC_CHATGPT_APP_PREVIOUS_DIRS` | Legacy additional frontend directories; external mounts remain retained, packaged retention is managed by the release manifest | `[]` |
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

New HTTP session initialization is also refused with HTTP 503 and `Retry-After: 60`
when V8 heap usage reaches 60% of its actual heap limit. Existing sessions remain
callable; no session is evicted and no paid action is replayed. Admission resumes
when memory is available. The production image enables explicit garbage collection;
at this threshold the server first collects reclaimable objects and rechecks the
same bound. Collection is limited to once per 30 seconds during sustained pressure.
Custom launchers should use `node --expose-gc dist/cli.js`; without that flag the
guard remains conservative. `mcp_runtime.memory.heapLimitBytes` reports that limit
alongside heap usage and session rejection counts. This guard bounds session
admission, not all request/response or upload memory; size container resources
with those workloads in mind.

The SDK is pinned to `1.32.1` with a small JSON-response cleanup patch in
`scripts/patch-mcp-sdk.mjs`. Completed responses must release their stream entry
immediately; retaining its resolver also retains the serialized response until
the session closes. The install hook patches both ESM and CommonJS builds and
rejects an unexpected SDK version or source layout. Installs that disable scripts
must run `npm run patch:mcp-sdk` explicitly, as CI does. The patch script is also
included in the published npm package and both Docker install stages. Remove it
only after an SDK upgrade passes the HTTP retention regressions.

After `npm run build && npm run package:chatgpt`, run `npm run test:memory:http`
to exercise the actual HTTP transport and every packaged widget release in a
512 MiB old-space process. It checks retained heap while sessions remain live,
then expires sessions and repeats the workload to verify recovery. It uses only
loopback HTTP and fixture API metadata; no credentials or generation calls are
needed. `src/http-response-cleanup.test.ts` also checks successful and failed RPC
responses, concurrent requests, and completion after a client disconnect without
cancelling or repeating the tool operation.

Tool schemas and stateless handlers are built once per HTTP factory. Discovery
descriptions are cached for the four supported presentation profiles. Immutable schema validators are shared too. Session
profiles, transports and request validation remain separate; credentials are resolved
per request. After `npm run build`, `npm run test:memory` exercises local session
load, graceful refusal, expiry and recovery in a 512 MiB old-space process. Add
`-- --burst` to defer initialization until all connections have reserved capacity,
covering clients that complete discovery after an initialization burst.

HTTP session limits apply only to the stateful remote transport. Sessions with requests in flight are protected from idle expiry. When capacity is exhausted, new session initialization returns `503` with `Retry-After`; existing sessions continue normally.

Host-provided upload source URLs must use HTTP(S) on the protocol default port, without credentials. IP literals and every DNS answer used by a source connection must be public unicast destinations. Private, loopback, link-local, reserved, mapped and transition addresses are rejected. Source redirects are rejected; hosts must provide the final download URL. Source connections use a dedicated direct dispatcher rather than an environment or global proxy.

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

HTTPS source tests use the local `openssl` command to create a one-day, self-signed
test identity. Temporary certificate and key files are removed before the tests run.

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
When an isolated Studio login requires the same-origin web proxy, set
`SYNC_OAUTH_AUTHORIZATION_URL` to its `/api-proxy/v2/oauth/authorize` URL, while
keeping `SYNC_BASE_URL` on the direct isolated API listener. Only browser
navigation uses the web proxy. Registration, code exchange, refresh, revocation,
userinfo and tool calls use the direct API and retain existing deadlines,
PKCE and confidential-client checks. The optional URL must use HTTP(S), with no
credentials, query or fragment. Existing deployments need no new setting.

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

For production, package the approved `@sync/chatgpt` build and select it in
`deploy/chatgpt/releases.json`; Docker activates that release automatically.
For local development, supply `app.html` and `manifest.json` together in
`SYNC_CHATGPT_APP_DIR`. The server verifies the
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
Both CSP metadata formats include `blob:` for local recording review and
`data:` for static assets embedded in the verified HTML, including Studio's font.
These schemes apply to the host's static-resource policy, including scripts and
styles; this is not a font-only exception. Configured network resource and
connection origins still require exact HTTPS origins. Neither scheme is added
to connection or frame permissions.

Set the widget origin and the exact media origins for the target environment.
Browser API connections are not allowed by this UI resource's CSP; backend
operations go through the authenticated MCP bridge. The frontend remains
disabled unless its widget domain (packaged deployment) or local directory is configured. The production container
includes the pinned frontend under `/app/chatgpt-dist/<HTML SHA256>`. Docker
verifies the bundle with the same manifest loader used by the server before
copying it into the final image. See [frontend release packaging](docs/chatgpt-release.md)
for provenance, automatic release selection, retention, and rollback. Real
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

Downstream tool responses with status 401 include `mcp/www_authenticate` pointing
to the same protected-resource metadata as the HTTP authentication middleware.
Tool descriptors expose `securitySchemes` and its compatibility metadata mirror.
403 permission failures and service outages do not request another sign-in.
`get-account-context` preserves verified account/workspace identity when optional
seat and voice-clone limits are unavailable; a limits 401 still requests linking.

To verify account recovery across the packaged UI and the real MCP HTTP server:

```bash
npm run build
node scripts/verify-account-recovery.mjs /path/to/sync-api-v2/apps/chatgpt/dist/app.html
```

Build the ChatGPT workspace first and install Playwright Chromium. The check uses
a local fixture for the Sync API and OAuth provider, exchanges a fixture code
through the actual MCP token proxy, and verifies the connected identity despite
a usage outage. It asserts that recovery makes no paid requests. Screenshots and
a browser trace are written to `temp/account-recovery/`. This proves the local
cross-service flow; the live ChatGPT consent UI still needs release acceptance.

`npm run test:browser` verifies an 11 MB browser upload through the real relay to fixture
storage. Install Chromium with `npx playwright install chromium` first. This does not
prove live authenticated storage delivery or authorize a production rollout.

The hosted Studio asset library uses the existing authenticated asset update,
delete and signed-download endpoints. These tools preserve upstream
permission checks and write annotations; the UI requires an explicit asset
rename or delete action and reconciles an interrupted response before offering
another write. Connected account context includes only the displayed identity,
organization and seat/voice-clone limits, with nullable identity fields preserved.
Voice cloning accepts exactly one source form: a URL, saved asset, or sample URL
list. A sample list creates one voice, not a voice per sample; uncertain clone
admission must be reconciled from the voice list without automatically resending.

The embedded continuation adapters accept an optional `continuation` object on
saved-asset lipsync, translation and dialogue generation: `{ workflow,
parentGenerationId }`. They recheck project access and the exact parent's project
membership through Studio's existing read endpoints, then forward `x-sync-workflow`
and `x-sync-parent-generation-id` headers to `/v2/generate`. Persist this context
with the approved request and key. Older saved requests without it keep their
original header set and idempotency fingerprint; do not add context on recovery.
Submission checks do not read unrelated parent media or parse its settings, so
deleting an old source does not block same-key reconciliation. The API still
authorizes the inputs of a new submission. `get-generation-continuation` retains
its full source-access checks before returning media or settings to the app.

Asset previews must use only the exact `thumbnailUrl` returned by Sync for the same
asset. The server instructions and asset discovery tools prohibit web-image
search, generated images and source-media substitutions. Missing or failed
thumbnails use `/asset-placeholder.svg`, a static black image with the Sync logo.
Hosts that cannot display it should report an unavailable thumbnail. This guidance
does not control arbitrary model prose; the embedded Studio library enforces the
thumbnail-only rule and its loading/error fallback directly.
