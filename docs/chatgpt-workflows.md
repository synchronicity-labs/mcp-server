# Expanding ChatGPT workflows

Tracking: [CRAFT-6457](https://linear.app/sync-labs/issue/CRAFT-6457).
Release is on hold while the next workflow is prepared alongside the cost display.
Merging a PR into this repository's `main` starts a production deployment.

## Translate & Dub: first integration

`create-translate-and-dub` uses the existing public `POST /v2/generate`
contract. It sends one saved video asset and `dubParams` and returns the parent
generation ID. The API owns the linked dubbing job, final lip-sync submission,
billing, and recovery. The widget must not start a second generation when the
dubbing stage finishes. Poll `generate_get-generation` for the parent ID and use
`projects_get-generations` for project history.

The tool is available only when the loaded public OpenAPI contract declares the
target/source language enums. It derives those enums from that contract. The
hosted catalog still excludes the unrestricted generated create operation and
internal standalone dubbing routes.

Inputs are a durable video asset ID, accessible project ID, API model name,
language selection, optional supported model settings, and a persistent
idempotency key. Upload/record/import first using the existing asset tools.
API admission remains responsible for same-organization asset ownership, audio
presence, model eligibility, media limits, credits, and concurrency. The adapter
also verifies project access before generation. It forwards request-scoped OAuth
and the existing trusted source-header behavior without accepting auth headers
from tool arguments.

The caller stores the key and frozen request before sending. An ambiguous
response does not authorize another key or new job. Explicit recovery repeats
the same key and payload, preserving returned generation IDs and retry deadlines.
The adapter itself performs no write retries or provider requests.

### Remaining before enabling the workflow UI

1. Add an authoritative combined estimate. `generate_estimate-cost` currently
   returns lip-sync pricing only. Dubbing admission uses separate organization,
   provider-key, allowance, and credit rules. Do not present the lip-sync number
   as the total, hardcode a dubbing rate, or assume translation is free.
2. Implement [CRAFT-6458](https://linear.app/sync-labs/issue/CRAFT-6458): source
   video, canonical language picker, model controls, full cost review, explicit
   generation action, persisted submission state, progress and final video.
3. Reuse the existing project history, input/output comparison, playback,
   download and new-generation controls. Reopening must only resume reads or
   explicitly recover the same keyed request.
4. Verify against the real API in an approved test organization, including
   denied assets/projects and plan restrictions. Then verify a translated final
   video in ChatGPT with an agreed paid-test budget. Mock HTTP tests establish
   the adapter contract, not backend authorization or final video quality.

The current UI remains unchanged. Conversational use of this new tool must
confirm the paid action and disclose that translation can add charges beyond
the existing lip-sync estimate. Do not publish this batch as a completed
cost-reviewed Translate & Dub workflow until the above acceptance is met.

## Next mappings to complete

| Workflow | Existing API building blocks | Remaining integration |
| --- | --- | --- |
| Translate & Dub | Public `/v2/generate` with `dubParams`, normal generation status/history | Combined estimate, embedded form, live acceptance |
| Edit Dialogue | Public create/read `/v2/dialogue-edits`; `/v2/generate` accepts `dialogueEdit: { id }` with the original video | Transcription/editor contract, preview pricing and recovery, narrow tools; final generation requires previews with segment lip-sync and section expansion |
| Edit Appearance | Internal appearance preview controller; existing Studio generation flow | Audit supported access, preview inputs and pricing, model constraints, persistence and final-render contract before exposing tools |

`@Internal()` marks API documentation visibility; it is not evidence by itself
that OAuth is accepted or rejected. Do not bypass authentication or expose
internal/debug endpoints to satisfy tool discovery.

## Verification and batch release

The translation adapter tests cover public-schema discovery, request shape,
language validation, project denial, OAuth caller isolation, cancellation,
unknown outcomes and stable-key retries. Existing app-tool regressions protect
lip-sync behavior. They use fixture API responses and incur no generation cost.

Keep the frontend source promotion and MCP package release unmerged while
developing. After the intended features are verified, rebuild the frontend from
the selected merged source, update the package release, retain older UI bundles,
and follow the existing release process. New tool discovery requires a
successful publisher scan; deployed tool success is not visual UI acceptance.
