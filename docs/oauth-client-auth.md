# CRAFT-5992: confidential client authentication

Support `client_secret_post` and the existing `client_secret_basic` compatibility
path on both `/token` and `/revoke`. Both are normalized into exactly one
body-secret request for the Sync API to validate. Metadata advertises these two
methods. Registration normalization still defaults/forces confidential
`client_secret_post`, including when a client requests `none`; this preserves
existing registration and cold-client recovery behavior. No public-client support
or SDK upgrade is introduced.

Evidence for compatibility: merged MCP PRs [9](https://github.com/synchronicity-labs/mcp-server/pull/9)
and [37](https://github.com/synchronicity-labs/mcp-server/pull/37) document ChatGPT's
Basic path and the cold-cache secret gap. Sync API source examined at
`624e3f98954197ff93d234f3a73946bdfcc1a9a1`,
`apps/api/src/modules/oauth/oauth.controller.ts`, routes token/revoke credentials
from body DTOs to the service. This is source evidence, not live-client evidence.

[RFC 6749 sections 2.3/2.3.1 and 5.2](https://www.rfc-editor.org/rfc/rfc6749)
permit one authentication method per request, require form decoding for Basic,
and specify invalid_request for multiple credentials/methods. Basic authentication
failures receive 401 with a Basic challenge. [RFC 7009 section 2.1](https://www.rfc-editor.org/rfc/rfc7009)
uses the token-endpoint client authentication rules for revocation.

| Input | Result |
| --- | --- |
| Complete body credentials, no Authorization | Forward unchanged secret |
| Valid Basic, no body credential fields | Decode once and forward body credentials |
| Any mixed Basic/body credentials, even matching or empty | 400 invalid_request, no forwarding |
| Repeated OAuth parameters / Authorization headers | 400 invalid_request, no forwarding |
| Malformed Basic / unsupported Authorization scheme / empty Basic values | 401 invalid_client + Basic challenge |
| Missing/empty body credentials | 400 invalid_client |
| Client assertion method | 400 invalid_request |
| Backend 401 after Basic authentication | Preserve 401/error body and add Basic challenge |

Tests exercise the actual hosted Express routes against a local HTTP backend,
including cold-cache code exchange and refresh, both revocation methods, metadata,
malformed/mixed/duplicate inputs, form encoding and secret-free diagnostics.
Existing provider tests preserve registration and cache-miss recovery. No actual
ChatGPT/Claude/Muse connection has been claimed or tested. Real client acceptance
requires the designated test account/organization, fixtures and budget.

Run `npm test -- --no-file-parallelism`, `npm run lint`, `npm run typecheck`,
`npm run build`, `git diff --check`. Serial file execution avoids the existing
upload tests' shared temporary-directory snapshot race. Preserve the separate
5991 local bearer-auth import when integrating `http-server.ts`. Client profiles,
widgets and Origin behavior are outside both fixes.

## Review follow-up

The flagged unanchored trailing-padding replacement has been removed. The parser
compares the validated input with canonical and unpadded base64 using index/slice
operations; no repeated-suffix regex scans remain. Canonical padded/unpadded inputs
remain accepted, malformed padding rejected, including million-character fixtures.

Fixture teardown guards absent/non-listening hosted servers, closes every created
server even after partial startup, and always restores process listeners/mocks in
finally blocks. Regression cases cover failure before upstream creation, before
hosted creation, after hosted creation, and after both servers start, preserving
the original error and supporting repeated cleanup. No runtime session enforcement
or shared http-server.ts edits are included in this follow-up.
