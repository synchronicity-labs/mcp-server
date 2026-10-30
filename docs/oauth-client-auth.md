# CRAFT-5992: confidential client authentication

Support `client_secret_post` and the existing `client_secret_basic` compatibility
path on both `/token` and `/revoke`. Both are normalized into exactly one
body-secret request for the Sync API to validate. Metadata advertises these two
methods. Registration normalization still defaults/forces confidential
`client_secret_post`, including when a client requests `none`; this preserves
existing registration and cold-client recovery behavior. No public-client support
or SDK upgrade is introduced.

## Diagnosing a publisher connection

Both `/token` and `/revoke` emit `oauth_exchange_rejected` on failure and
`oauth_exchange_succeeded` when the upstream accepts the exchange. Events include
the existing `requestId`, `oauthPath`, `grantType`, `source`, and `statusCode`.
Match `requestId` to the response's `x-request-id` and the `http_request` event.
An exchange success alone does not prove that the client received or saved its
tokens, or that a later publisher scan succeeded.

Credential diagnostics contain fixed labels only:

| Field | Values / meaning |
| --- | --- |
| `bodyClientId`, `bodyClientSecret` | `missing`, `empty`, `present`, or `non_string`; presence in the incoming form, not validity |
| `authorizationScheme` | `none`, `basic`, or `other`; describes the header without decoding or logging it |
| `authorizationHeaderPresent` | Existing boolean retained for log consumers |
| `reason` (rejections only) | Allowlisted reason such as `invalid_client_secret`, `refresh_token_invalid_revoked_or_expired`, or `organization_access_revoked`; otherwise `unrecognized_response` |

A valid Basic request has both body credential fields `missing`. Do not interpret
those fields without `authorizationScheme` and the rejection reason. A local
`invalid_client_authentication` with scheme `none` and missing/empty form fields
means required credentials did not arrive. An upstream `invalid_client_secret`
means the API rejected the supplied secret. Refresh-token rejection does not by
itself distinguish expiry, revocation, or reuse after rotation. Logs intentionally
omit client IDs, secrets, tokens, authorization headers, and arbitrary upstream
response text. These labels do not identify a request as OpenAI's.

For one controlled publisher attempt:

1. Record the UTC time, publisher scan ID, failed URL/status, OAuth error, and
   `x-request-id` from the publisher or OpenAI support. Never request credential
   values. If Reconnect/Rescan is disabled, obtain a supported connection-recovery
   path from OpenAI before proceeding.
2. Match the request ID to these events and the HTTP completion event. The ID is
   local to the MCP hop; it is not currently forwarded to the API. Distinguish
   local validation, upstream rejection, and transport/timeout failures before
   changing code. Do not identify callers from a request-ID prefix alone.
3. Repair missing stored connection credentials through the supported reconnect
   flow, or reproduce the demonstrated server/rotation defect with an isolated
   client and a regression test. Do not weaken authentication to accept a scan.
4. Verify initial authorization-code exchange, a subsequent refresh exchange,
   and a completed publisher scan with expected tools/resources. Record separate
   evidence for each. A package approval or a reconnect alone is not acceptance.

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

Run `pnpm test --no-file-parallelism`, `pnpm run lint`, `pnpm run typecheck`,
`pnpm run build`, `git diff --check`. Serial file execution avoids the existing
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
