# MCP availability and session capacity

`/health` is process liveness, not proof that clients can initialize or call tools.
Do not point a restart probe at an admission-capacity check: restarting interrupts
sessions and invalidates process-local upload tickets without fixing load.

## Session lifecycle

See [the session-state decision](session-lifecycle.md): SDK transports are now
request-scoped; only ownership, presentation and cancellation context persists.

Idle sessions expire after two minutes (`MCP_SESSION_IDLE_TTL_MS=120000`); the
sweeper runs every 15 seconds (`MCP_SESSION_SWEEP_INTERVAL_MS=15000`). Admission
also expires idle entries, so a full table does not wait for the next sweep.
At the count limit, admission may reclaim the oldest session with no in-flight
request and at least 30 seconds of inactivity. Recent initialization handshakes,
pending reservations, and in-flight tool calls remain protected. Memory admission
still applies after reclamation. Expired IDs return 404; hosts must reinitialize.
No tool action is replayed by session recovery.

## Authenticated synthetic check

Run `pnpm run monitor:mcp` against `MCP_MONITOR_URL` (default
`https://mcp.sync.so/mcp`). Supply `MCP_MONITOR_ACCESS_TOKEN` through the runner's
secret injection. It must be a **fresh OAuth access token**, not an API key.
The runner must own a dedicated monitoring account's credential refresh lifecycle;
do not reuse a user's ChatGPT refresh token or put a short-lived access token in
a permanent cron configuration. The check never logs account contents or tokens.

The probe initializes the real SDK client, lists tools, calls the fixed read-only
`get-account-context` tool, reads authenticated aggregate `/status`, then deletes
its session even on failure. Requests have deadlines and reject redirects.
A successful HTTP status containing an MCP tool error is a failure.

Exit codes:

- `0`: protocol, read-only call, cleanup and headroom checks passed.
- `1`: availability, authentication, protocol, metrics or cleanup failed. The
  sanitized error names the failing stage.
- `2`: the functional check passed, but session occupancy is at least 80% or
  active requests reach 80% of their limit, or heap use reaches 60% of the V8 heap limit.

The synthetic checker is deployment tooling, not an automatically activated
production monitor. Configure credential refresh, a one-minute runner, alert
routing and an owner before considering monitoring enabled. Run against the
candidate first, and confirm a deliberate failure reaches the alert destination.

## Alert policy

Use the existing structured `mcp_runtime` records, grouped by pod. Counters reset
on process restart: compute positive deltas within each process lifetime rather
than summing lifetime totals or differencing across pods.

| Signal | Initial threshold | Action |
| --- | --- | --- |
| Synthetic availability | 3 consecutive failures at one-minute intervals | Critical |
| Admission refusal | `rejectedCapacity` or `rejectedMemory` increases in each of 3 consecutive one-minute windows | Critical |
| Occupancy | `(sessions.active + sessions.pending) / sessions.limit >= 0.8` for 5 minutes | Warning |
| Request pressure | `requests.inFlight / requests.limit >= 0.8` in the authenticated probe for 5 minutes | Warning |
| Heap pressure | `memory.heapUsedBytes / memory.heapLimitBytes >= 0.6` for 5 minutes | Warning |
| Churn | `sessions.created` increases by over 120/minute for 5 minutes per pod | Warning; inspect tool mix and idle reclamation |
| Missing probe or telemetry | No successful scheduler report or runtime sample for 3 minutes | Critical |

`expired`, `evicted`, `inFlight`, `pending`, and separate capacity/memory rejection
counters explain whether traffic is doing useful work or retaining idle sessions.
An increase in initialization traffic alone is not proof of more end users.

## Regression and release checks

`pnpm run test:memory:http` sends real HTTP initialization/discovery requests with
fresh sessions and no DELETE, at a virtual 160 sessions/minute for 45 minutes.
It checks bounded sessions, retained heap, zero admission refusals and cleanup.
Time is accelerated for CI; this is not a wall-clock production soak.
Registry and HTTP ownership tests also cover reclamation, expired-ID recovery,
reserved capacity, memory pressure, and protected in-flight requests.

Before production rollout, verify ChatGPT and other supported hosts reinitialize
after idle expiry. Run an isolated 45-minute wall-clock soak with multiple mounted
views and a long request; verify no duplicate actions. Monitor the first deployment
for admission refusals, heap growth and expiry recovery. Frontend polling changes
must be built and packaged into an MCP UI release; source changes alone do not
update installed clients. Server cleanup also protects older retained UI bundles.

Do not add replicas without addressing routing for process-local MCP sessions and
upload tickets. A higher session cap alone increases memory exposure.

## Rollout and rollback

The normal Porter workflow deploys reviewed merges to `mcp-server/main` in
project 11208, cluster 4151. The widget source hotfix targets `sync-api-v2/main`;
its immutable build is packaged in the MCP image. Keep one production replica:
this release does not introduce cross-pod session/upload routing.

Before merging, record the deployed image, current widget digest, green checks
and reviewer approval. The baseline observed on 2026-10-28 was image
`mcp-server:8a922e289d5488c7f50f258e1ca4d6ce25e925ad` and UI
`fc578cad600cf392a971ad28d2e6e591c84466d0bfb1521727d90e25eefe5e43`.
Preflight later found the independent cost-estimate fix #108 deployed as
`mcp-server:2b2a5bf9c6cf1ff7267f5beb9c7e7e22cd5be710`; it retains the same UI.
That newer image is the rollback target, and this candidate includes its changes.
If the candidate regresses authentication, discovery, cancellation or uploads,
redeploy that latest known image through Porter (or revert the release merge through
the normal reviewed workflow). Existing transport IDs may need reinitialization;
check any accepted paid job by its existing ID, never resubmit automatically.
The previous UI remains in the retained catalog for rollback and older widgets.

Record the deployed SHA/pod image and widget hash, then perform a fresh publisher
rescan and fresh ChatGPT opening. Separately verify visible/hidden polling,
chat-to-Studio receipts, unsent draft preservation, byte-exact fixture upload,
cancellation, expiry/reinitialization, and concurrent tabs/users. Collect session
summaries and heap/count samples for at least a complete retention interval.
An old-revision successful scan or account read is only baseline evidence.

Monitoring is blocked until an operator provisions a dedicated OAuth monitoring
identity with maintained token refresh and an external runner. No matching
credential was found among production API Doppler secret names or MCP GitHub
Actions secrets. The available Porter Kubernetes identity is read-only and
cannot inspect secrets or provision a runner. Existing managed Grafana contact
points are available, but their presence does not prove this probe is routed.
Do not mark monitoring active until a deliberate failed probe and recovery have
both reached the intended alert destination and missing-run detection is tested.
