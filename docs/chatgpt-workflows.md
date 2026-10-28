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

## Generation status cards

Video submission tools attach `ui://sync/generation-status-v1.html` directly,
including lipsync/image-to-video, Translate & Dub, Edit Dialogue and the stdio
public generation tool. The host renders this resource from the returned job;
it does not depend on ChatGPT suggesting a follow-up or choosing another render
tool. Rejected submissions without a known job cannot offer a status read.

The card pins its originating generation ID and uses only
`generate_get-generation` for manual checks and ten-second automatic updates.
Polling stops on terminal states, read errors or hidden documents. Foregrounding
an active card rechecks it. A known job ID in an uncertain submission error is
read back without replaying the write. Both MCP Apps and ChatGPT's legacy
bridge keep a bounded read timeout and a usable Check status action after errors.

Time remaining is derived from `generationEstimate.estimatedFinishAt` and the
returned `serverTime`, advancing with a monotonic clock. Missing/invalid estimates
show unavailable; overdue jobs show a delay message instead of zero or a new ETA.
Terminal jobs hide the estimate. Playback links are exposed only after a fresh
authorized status read, and signed result URLs remain intact. `projectId` is
included in the safe generation projection for the exact Open in Sync fallback.

The card is compiled into MCP and does not require a Studio bundle release.
Deploy MCP and refresh the ChatGPT publisher/tool metadata so existing cached
descriptors acquire the resource link. The embedded Studio's corresponding
status card ships through its normal frontend bundle release. Local protocol
and browser fixtures do not establish deployment or live ChatGPT rendering.

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

## Chat and Studio draft selections

When an editable Studio is open, its model context includes the canonical
`projectId`, `draftId`, revision, editable status and current inputs. Use
`get-studio-draft` to read the latest document before `update-studio-draft`.
The update accepts a revision and a partial patch of media IDs, workflow,
model/options, languages and unsent speech settings. It never starts a job.

A successful update means the change is saved for Studio. Report it as applied
only when `appliedRevision` equals `revision`. Studio performs fresh media reads,
saves its local recovery journal, applies the inputs, and acknowledges that
revision. If both chat and Studio changed the draft, Studio asks the user which
changes to keep. A closed widget or active recovery can leave changes pending.
Never retry a stale revision by automatically overwriting the newer draft.

The save and acknowledgement tools are app-only. Provider request keys,
accepted requests, signed URLs and recovery receipts are not editable through
the chat draft patch. Appearance and timeline editing remain excluded.
Synchronization tools are advertised only when the companion API capability is
available; older API releases retain local Studio editing.
