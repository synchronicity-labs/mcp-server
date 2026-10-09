# Stateful MCP across replicas

The HTTP transport keeps live SDK sessions and single-use upload grants in process
memory. Randomly balancing subsequent requests across pods loses both. This release
adds application-level owner routing so five or more pods can accept requests while
all requests for an existing session or upload go to its owner.

## Design and boundaries

- With `MCP_REPLICA_SERVICE` configured, new session and upload identifiers contain
  an IPv4 owner address plus 256 random bits. The address is a routing hint, not
  permission. The full identifier must still exist in the owner's registry.
- Every MCP request is bearer-authenticated before forwarding and again at the owner.
  Existing subject, OAuth client and organization ownership checks still apply.
  Refreshed tokens do not change the destination.
- A destination must appear in the configured headless service's DNS answers and be
  a private IPv4 address. No client-controlled hostname, URL, port or redirect is
  followed. Only `/mcp` and `/app-upload` are forwarded, with explicit header lists.
- Browser uploads need no new cookie or credential. Their existing secret ticket
  routes the bytes to the issuer; exact size/type, expiration and atomic single-use
  consumption remain unchanged. The relay streams with backpressure.
- No automatic request retry occurs, especially for paid tools. Interrupted calls
  are ambiguous: look up their existing operation ID before resubmitting anything.
- Requests, responses, SSE streams, DELETE and cancellation notifications all route
  to the same live SDK transport. Original client IP is preserved for rate limits;
  routed requests count at both entry and owner, so monitor rate-limit responses.
- DNS is cached for two seconds, with a bounded lookup timeout. Discovery failures
  return 503 without forwarding; unknown/departed owners return MCP 404 or upload 403.
  A connection reset is 502, not permission to replay a paid request.
- Session and grant state is not replicated. Owner restart/loss requires a new MCP
  initialization, and a new grant for unstarted uploads. Successful generations and
  registered assets remain in the API. Client recovery after pod loss must be tested.
- Existing unprefixed IDs cannot be routed to an owner. They expire/reinitialize
  during rollout. Expect reconnects; do not claim zero-disruption upgrades.

## Deployment (separate approval; not performed by this PR)

1. Apply `deploy/mcp-replica-peers.yaml` through the normal infrastructure process.
   Verify selectors match only this MCP deployment, DNS returns each pod IP, and
   existing network policies allow MCP-to-MCP TCP 3002 plus cluster DNS. The service
   is internal and does not add a public endpoint. Keep draining pods discoverable.
2. Configure every replica identically:
   - `MCP_REPLICA_SERVICE=mcp-server-peers.default.svc.cluster.local`
   - `MCP_REPLICA_PORT=3002`
   - Porter already supplies `PORTER_POD_IP` through the downward API. Other
     environments must set `MCP_REPLICA_IP` from `status.podIP`.
3. Deploy the reviewed image to all five replicas. All replicas must run the new
   router with matching configuration. Do not enable it on only some replicas.
   Mixed old/new traffic can fail until rollout completes and clients reinitialize.
4. Reopen a fresh ChatGPT conversation. Repeat read-only tool calls, token refresh,
   UI resources, and an approved fixture upload while requests enter different pods.
   Confirm the owner handles them and no cross-replica 404s occur. Test cancellation
   and a rolling restart. Verify a terminated session recovers by initialization,
   never by resubmitting a paid generation.
5. Monitor 404, 403, 429, 502 and 503 separately. Authentication probes can legitimately
   return 401; aggregate HTTP errors alone are not a session-loss metric.

Rollback: restore the prior image/config through the normal release process. The
prior image still requires a single instance or externally proven owner routing.
Turning this feature off while keeping five randomly balanced replicas is not a
safe rollback. Existing routed IDs and pending upload grants may require renewal.

No listing/package metadata, tool schema, OAuth scope, storage CORS, or paid behavior
changes. IPv6-only clusters are not supported by this opt-in routing implementation.
