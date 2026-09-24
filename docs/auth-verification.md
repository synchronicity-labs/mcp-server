# CRAFT-5991: token verification

The installed MCP SDK is 1.27.1. Its bearer middleware maps general OAuthError
subclasses (including TemporarilyUnavailableError) to HTTP 400. The local
`auth/bearer-auth.ts` adapter translates verification dependency failures and
otherwise delegates challenges, expiry and scope checks to that SDK middleware.
Keep this import when integrating shared `http-server.ts` changes.

| Userinfo result | Protected endpoint result |
| --- | --- |
| Valid 200 | SDK validates expiry/scopes, then admits |
| 401 / 403 | 401 invalid_token with SDK resource-metadata challenge |
| 429 | 429 temporarily_unavailable, no authentication challenge |
| 5xx / network / timeout | 503 temporarily_unavailable, no challenge |
| Other unexpected status / malformed response | 502 temporarily_unavailable |

Verification has a five-second deadline covering headers and body consumption,
uses native fetch cancellation, and is cancelled when the client disconnects.
A promise race also bounds transports that fail to honor abort. There are no
retries or token caches. Valid Retry-After delta-seconds or canonical HTTP dates
are forwarded; malformed values are omitted. Errors contain no upstream body,
exception text or token. Missing expires_at retains the existing one-hour
fallback; this is not a caching policy.

Tests cover success/rejection, rate limits/outages, malformed JSON/shapes,
network failure, missing/expired tokens, scopes, safe Retry-After, pre-cancel,
disconnect, mocked stalled fetch/body, and native HTTP partial-body timeout.
Run `npm test -- --no-file-parallelism`, `npm run lint`, `npm run typecheck`,
`npm run build`, and `git diff --check`. Serial file execution avoids an existing
upload test's process-wide temporary-directory snapshot race with upload tests
in other files. No upload implementation is changed.

Evidence is local/mock only. Real ChatGPT/Claude/Muse acceptance and deployment
remain with integration/release owners. This reconstructs the unavailable
historical implementation under the user's explicit continuation instruction;
it does not claim equivalence to those unpublished commits or their review.
