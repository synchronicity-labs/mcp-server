# Production ChatGPT scan failure, 2026-10-02

## Confirmed evidence

- Production MCP revision: `c24a5e2579012a44acd3bdfa7ac9bb304a65bca3`.
- OpenAI scan attempt: `01a0fe71-84f3-75b1-8e5b-3ebe7d62f7d8`.
- The portal reported completion at `2026-10-02T21:07:30.113062+00:00`
  with problem code `unknown`, and retained the previous tool review.
- MCP logged `POST /token` with status `400` at
  `2026-10-02T21:07:29.853Z`, duration `257.77` ms, and request ID
  `wfr_01a0fe7184f375b18e5b3ebe7d62f7d8`. The request ID exactly matches
  the failed scan UUID after removing hyphens and adding `wfr_`.
- The scanner failed at OAuth exchange, before discovery of the new UI tools.
  Health, authorization-server metadata, path-specific protected-resource
  metadata, and the domain challenge are reachable.
- The publisher UI says Authorized but exposes no Reconnect action in the
  inspected MCP card, server selector, or plugin actions menu.
- The saved released 1.0.0 and approved 2.0.0 tool definitions both contain the
  same five old tools. Neither includes `open-sync-app`.

## Not yet established

The existing logs do not contain the OAuth grant type or rejection reason.
The duration suggests an upstream rejection, but does not prove it. Expired,
revoked, or already-used refresh tokens, client registration problems, and local
request validation remain distinguishable possibilities. Do not change OAuth
validation or token lifetime based on the HTTP status alone.

## Diagnostic change

Failed OAuth exchanges now emit `oauth_exchange_rejected` with the same request
ID, path, local/upstream/timeout/transport source, status, allowlisted grant type, presence
of an Authorization header, and allowlisted error/reason labels. Unknown values
are replaced with fixed labels. Raw bodies, descriptions, client identifiers,
secrets, authorization headers, and tokens are not included. Response status and
body, client authentication, PKCE, and refresh-token rotation remain unchanged.

This change enables diagnosis; it does not by itself restore the scan.

## Verification and recovery

1. After an owner merges the diagnostic PR and the normal deployment completes,
   select Retry once in the production plugin MCP Issues panel.
2. Match the new scan ID to `oauth_exchange_rejected.requestId` in MCP logs.
3. When `grantType` is `refresh_token` and the reason is
   `refresh_token_invalid_revoked_or_expired` or the OAuth error is `invalid_grant`,
   renew the publisher's review connection using the supported Reconnect flow and retry.
   If the portal still hides Reconnect, request recovery of that review connection
   from OpenAI with the scan ID and timestamp. Do not revoke customer connections,
   disable authentication, or publish an unrelated package as a workaround.
4. For `authorization_code` with `invalid_grant`, inspect the authorization-code
   flow for expired/reused codes, redirect mismatch, and PKCE failure before
   starting a fresh authorization attempt. An `invalid_grant` without a known
   grant type does not establish a refresh-token failure. For local rejection or
   a client/PKCE mismatch, use the specific reason to
   reproduce the request shape with synthetic credentials and prepare a targeted
   compatibility fix before another production change. For `timeout` or
   `transport`, investigate upstream reachability/response handling first.
5. Confirm the scan actually discovers and approves `open-sync-app` and the
   workflow tools, then test opening the UI in a fresh ChatGPT conversation.
6. Finish widget upload/recording, both workflows, playback/download, and history
   acceptance. The previously verified ChatGPT attachment import is a different
   path from direct widget uploads.

MCP scans and package publication are separate. Per the
[OpenAI submission guide](https://developers.openai.com/plugins/deploy/submission),
eligible hosted-tool updates become available after their checks pass without a
new package upload or separate publication. Publishing package 2.0.0 alone is
not evidence that the new UI tools are available.
