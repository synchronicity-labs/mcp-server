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
| `MCP_SESSION_IDLE_TTL_MS` | Idle time before an inactive HTTP session is closed | `120000` (2 min) |
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
