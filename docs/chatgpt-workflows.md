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

### Packaged workflow and release gates

The combined estimate API is merged into dev in [API #6423](https://github.com/synchronicity-labs/sync-api-v2/pull/6423).
The packaged frontend includes source video selection, searchable language controls,
model controls, full cost review, explicit generation, persistent request recovery,
parent-job progress, final playback/download, and another-language reuse. It uses
the existing project history and Input/Output comparison. Both source and packaged
browser tests exercise these behaviors with fixture responses.

Deploy and verify the combined estimate API before this MCP release. The form
requires `workflow: "translate-and-dub"` and the full estimate breakdown, displays
credits or USD according to the response, and discloses excluded provider charges.
It rejects older lip-sync-only quotes rather than presenting them as a combined
total. Conversational use must also confirm the paid action and disclose exclusions.

Verify the exact combined package in the dev ChatGPT plugin before production.
After deployment and publisher metadata refresh, verify the actual production
widget. Fixture tests prove client and adapter behavior, not live account billing,
backend authorization, provider completion, or translated output quality. Live
paid tests require the reviewer's approved media and budget. API release review
findings and environment acceptance remain independent release gates.

## Next mappings to complete

| Workflow | Existing API building blocks | Remaining integration |
| --- | --- | --- |
| Translate & Dub | Public `/v2/generate` with `dubParams`, normal generation status/history | Production API promotion, combined MCP/UI release, live acceptance |
| Edit Dialogue | Public create/read `/v2/dialogue-edits`; `/v2/generate` accepts `dialogueEdit: { id }` with the original video | Transcription/editor contract, preview pricing and recovery, narrow tools; final generation requires previews with segment lip-sync and section expansion |
| Edit Appearance | Internal appearance preview controller; existing Studio generation flow | Audit supported access, preview inputs and pricing, model constraints, persistence and final-render contract before exposing tools |

`@Internal()` marks API documentation visibility; it is not evidence by itself
that OAuth is accepted or rejected. Do not bypass authentication or expose
internal/debug endpoints to satisfy tool discovery.

## Verification and batch release

The translation adapter tests cover public-schema discovery, request shape,
language validation, project denial, OAuth caller isolation, cancellation,
unknown outcomes and stable-key retries. A real local HTTP plus MCP SDK test
verifies estimate workflow forwarding, caller OAuth context, and preservation
of the full breakdown and unpriced external charges. Existing app-tool regressions protect
lip-sync behavior. They use fixture API responses and incur no generation cost.

Keep the frontend source promotion and MCP package release unmerged while
developing. After the intended features are verified, rebuild the frontend from
the selected merged source, update the package release, retain older UI bundles,
and follow the existing release process. New tool discovery requires a
successful publisher scan; deployed tool success is not visual UI acceptance.

The embedded language form reads `get-translation-options`, an authenticated,
read-only tool whose lists come from the same public schema as submission. It
creates no job and makes no billing request. Older servers leave translation
unavailable; the form additionally requires a combined estimate breakdown.
