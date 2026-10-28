# HTTP session lifecycle

## Why retain a session identifier?

The installed MCP SDK supports truly stateless HTTP (`sessionIdGenerator:
undefined`), and this server now uses that mode for **each request's transport**.
It does not retain SDK servers or transports between HTTP requests.

Removing the host-visible session identifier is not compatible with the current
contract. Two things still need a small, isolated context:

- The initialize handshake supplies the client name. ChatGPT, Codex and generic
  clients receive different discovery schemas, upload support and resources.
  Later requests need not repeat `clientInfo`. OAuth identifies an account and
  client registration, not the tab's presentation profile.
- `notifications/cancelled` identifies an in-flight request by its JSON-RPC ID.
  Two tabs belonging to the same OAuth principal can concurrently use ID `0`.
  A map keyed by user and request ID would let one tab cancel another. A fully
  stateless transport created for the cancellation POST has no matching handler.

The retained context therefore contains a bounded client name, ownership claims,
initialization flag and **only currently running** request instances. It contains
no token, tool arguments, responses, widget HTML or idle SDK graph. Every request
still passes bearer verification; token refresh does not change ownership. Every
initialization gets its own random ID, never one shared session per user.

The server creates one SDK server and stateless transport for a request, uses the
session's established client profile, then closes them in `finally`. Cancellation
aborts only the named handler, including ID `0` inside a legacy batch. A
disconnected response always closes the SDK graph, even when a cancelled batch
can no longer produce every response.
Paid work already accepted upstream is not undone or replayed. DELETE explicitly
closes the context and its active requests. A rejected initialization is removed.
Active SDK requests have a separate default limit of 32 (`MCP_MAX_IN_FLIGHT_REQUESTS`).
Session count, heap admission, active request admission, idle expiry and shutdown
drain remain bounded. Heap pressure can refuse new work on a reused session;
DELETE and cancellation remain available for cleanup.

GET returns 405: this JSON-response endpoint does not publish unsolicited events.
An idle standalone SSE connection must not prevent expiry. Widget resources are
immutable shared release data. Upload grants live in the existing independently
bounded, one-use upload runtime; releasing a request does not revoke its grant.
Studio view ownership and drafts live in the API and remain scoped to their exact
view/draft IDs. HTTP transport sessions do not own editor state.

## Evidence and limits

Before this change, a 15-minute production sample contained 506 initializations,
505 initialized notifications and 447 Codex Studio heartbeat tool calls; the
process reported 587 retained sessions and zero closes/expirations at 17 minutes.
The sample is **aggregate evidence**, not proof that every tool call created a
session. Existing logs cannot reconstruct that relationship retrospectively.

New `mcp_rpc_request` events join HTTP request IDs to process-local HMAC
`sessionRef` values and ordinal request counts. `mcp_session_closed` records
request/tool/discovery counts, allowlisted client, presentation profile,
negotiated protocol, lifetime, idle time and closure reason. Never log raw session
IDs, tokens, account IDs, arguments or results. The random HMAC key changes on
restart, so pseudonyms cannot correlate sessions across process lifetimes.

After rollout, collect at least one full expiry interval while separately opening
ChatGPT, making a harmless chat call, leaving a widget visible, hiding it, and
closing it. Group by `sessionRef` and client/tool, count tool calls per closed
session, and distinguish DELETE from idle expiry. Treat app-only heartbeat/draft
tools as widget traffic; shared tools alone do not reliably identify the caller.
Do not claim this production evidence until the instrumented revision is deployed.

## Validation

`http-session.test.ts` verifies graph closure after every response, repeated
requests and identical in-flight IDs in separate tabs. `session-ownership.test.ts`
checks real bearer validation, token refresh, foreign users/clients/organizations,
expiry recovery and cancellation. `client-profile.test.ts` uses the request-scoped
HTTP path for concurrent ChatGPT/Codex/generic discovery, file bridge uploads,
resource reads and cancellation before generation submission.

`npm run test:memory:http` runs accelerated fresh-session churn with packaged UI
reads. `npm run test:memory:http -- --soak-minutes=20` uses real elapsed time,
fresh abandoned contexts plus eight reused contexts, harmless app-opening calls,
periodic packaged HTML reads, actual expiry and stable heap/count assertions.
These local tests use fixture identities and do not establish real ChatGPT
acceptance or production memory stability.

Protocol references: [HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and [cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).
