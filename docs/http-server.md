# HTTP server configuration

Settings and runtime limits for the HTTP transport, which the hosted deployment
runs. Moved out of the README, which covers connecting a client.

## Environment variables

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
| `MCP_SESSION_IDLE_TTL_MS` | Idle time before an inactive HTTP session is closed | `600000` (10 min) |
| `MCP_MAX_SESSIONS` | Maximum active and initializing HTTP sessions | `1000` |
| `MCP_SESSION_SWEEP_INTERVAL_MS` | Interval for idle-session cleanup | `15000` (15 sec) |
| `MCP_SHUTDOWN_GRACE_MS` | Time to drain active requests before forced shutdown cleanup | `10000` (10 sec) |
| `MCP_RUNTIME_TELEMETRY_INTERVAL_MS` | Interval for structured memory, CPU, event-loop, session, request, and upload telemetry | `15000` (15 sec) |
| `MCP_UPLOAD_MAX_BYTES` | Maximum declared or streamed size for a re-hosted upload | `536870912` (512 MiB) |
| `MCP_UPLOAD_CONCURRENCY` | Maximum concurrent re-host uploads per process | `2` |
| `MCP_UPLOAD_MAX_QUEUED` | Maximum re-host uploads waiting for process capacity | `8` |
| `MCP_UPLOAD_RETRY_AFTER_MS` | Suggested retry delay returned by upload overload errors | `5000` (5 sec) |
| `MCP_UPLOAD_TIMEOUT_MS` | End-to-end deadline for a queued or active re-host upload | `900000` (15 min) |

## Runtime limits

New HTTP session initialization is also refused with HTTP 503 and `Retry-After: 60`
when V8 heap usage reaches 60% of its actual heap limit. In-flight sessions remain
protected and no paid action is replayed. Admission resumes
when memory is available. The production image enables explicit garbage collection;
at this threshold the server first collects reclaimable objects and rechecks the
same bound. Collection is limited to once per 30 seconds during sustained pressure.
Custom launchers should use `node --expose-gc dist/cli.js`; without that flag the
guard remains conservative. `mcp_runtime.memory.heapLimitBytes` reports that limit
alongside heap usage and session rejection counts. This guard bounds session
admission, not all request/response or upload memory; size container resources
with those workloads in mind.

The MCP SDK v2 packages are pinned to exact versions. Completed responses must
release their stream entry immediately; retaining its resolver also retains the
serialized response until the session closes. SDK v2 does this itself, and
`src/http-response-cleanup.test.ts` keeps the ESM and CommonJS transports covered.
Re-run the HTTP retention regressions before every SDK upgrade.

After `pnpm run build && pnpm run package:chatgpt`, run `pnpm run test:memory:http`
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
per request. After `pnpm run build`, `pnpm run test:memory` exercises local session
load, graceful refusal, expiry and recovery in a 512 MiB old-space process. Add
`--burst` to defer initialization until all connections have reserved capacity,
covering clients that complete discovery after an initialization burst.

HTTP session limits apply only to the stateful remote transport. Sessions with requests in flight are protected from idle expiry. Admission first expires idle sessions, then reclaims the oldest session idle for at least 30 seconds when the session-count limit is reached. In-flight requests and pending initializations are protected. Expired/evicted IDs return 404 so clients can initialize again. If no eligible capacity remains or heap admission fails, new initialization returns `503` with `Retry-After: 60`.

Host-provided upload source URLs must use HTTP(S) on the protocol default port, without credentials. IP literals and every DNS answer used by a source connection must be public unicast destinations. Private, loopback, link-local, reserved, mapped and transition addresses are rejected. Source redirects are rejected; hosts must provide the final download URL. Source connections use a dedicated direct dispatcher rather than an environment or global proxy.

Re-hosted uploads are streamed through bounded temporary files before durable asset registration. The deployment needs writable temporary disk sized for `MCP_UPLOAD_MAX_BYTES * MCP_UPLOAD_CONCURRENCY`; a memory-backed temporary directory defeats the memory bound. When upload capacity is exhausted, excess work fails with the retryable `UPLOAD_CAPACITY_EXCEEDED` code instead of increasing process memory pressure.

The HTTP server writes newline-delimited JSON diagnostics to stderr. Lifecycle events distinguish graceful pod termination from abrupt process loss, request logs include latency and abort state, and `mcp_runtime` heartbeats include memory, CPU, event-loop delay, session totals, pending transports, aggregate HTTP status counts, and upload activity, queue, rejection, and byte counters.

### When a widget doesn't load

Every widget read (status card, upload widget, Studio app) writes one `ui_resource_read` line with `resource`, `clientProfile`, `clientName` and `outcome`: `served` with `bytes`, `refused` with a `reason` (`no_status_card`, `no_uploads`, `no_app_ui`), or `failed`. A refusal reaches the client as a JSON-RPC error inside an HTTP 200, so request logs alone don't show it.

When a client says it couldn't load the status card:

- An `mcp_session_not_found` near the create call, from the same `clientName`: the host sent the card's request on a session the server had already closed. Claude.ai has been seen reading a widget through its discovery session, not the session that called the tool, and that session can idle out while the turn runs. `cause` says why the session was gone and `closedAgoMs` how long ago.
- No `ui_resource_read` for `ui://sync/generation-status-v1.html` near the create call, and no `mcp_session_not_found`: the client never asked for the card, so the host rejected it before reading it.
- `refused`: the session resolved to a profile without the card; `clientName` shows what the client called itself.
- `served`, then no `mcp_rpc_request` with `tool: "generate_get-generation"` from that session: the card arrived but failed in the client's frame. A running card checks through that tool, so its absence means the card never started. Look at the client's developer console.

### When a client gets 404 Session not found

The server writes one `mcp_session_not_found` line per 404 with `sessionRef`, `httpMethod`, `rpcMethods` (with `tool` or `resource` for a single call or read) and `cause`:

- `expired`, `client_delete`, `evicted`, `shutdown` or `initialization_failed`: the session closed for that reason `closedAgoMs` ago. `clientName` and `clientProfile` are the closed session's. The `sessionRef` matches that session's `mcp_session_closed` line.
- `other_owner`: the session is live but belongs to another user, OAuth client or organization.
- `unknown`: this process never had the session, or closed it over an hour ago. Requests from before a deploy look like this.

Hosts must initialize a new session after a 404. One that keeps sending the same `sessionRef` doesn't.
