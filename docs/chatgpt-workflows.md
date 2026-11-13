# Project destination safety

A new workflow request creates a new project. A workflow label, matching project
name, or open editor never selects existing work. `lipsync_create` and
`dubbing_create` accept `projectName` only as the label of a new project;
there is no name-based lookup or shared default-project reuse.

Keyed generation without `projectId` requires a fresh UUID `projectCreationKey`.
MCP derives a separate namespaced project UUID from that key and the generation
key, then uses the API's idempotent project creation. Preserve both keys and the
name on uncertain retries. A new intentional action gets new keys. Copying an
existing project UUID into the creation-key field cannot select that project.
New projects persist the chosen workflow as `defaultWorkflow`.

For social video URLs, create the new project before importing, preserve its
creation UUID for retries, then carry the returned project ID through import,
estimation and generation. This avoids making separate import and output
projects. Existing projects may be used only for an explicit user project
selection/update; ambiguous names require clarification before writing.

Every model-visible write with a `projectId` requires `projectIntent: explicit`.
Missing intent returns `PROJECT_INTENT_REQUIRED` before upstream reads or writes.
This covers imports, generation, speech/translation/dialogue preparation, draft
changes and mounted-view actions. The marker is an explicit caller declaration;
server/tool/model-context instructions require it to reflect the user's request.
It does not replace authorization, revision checks or paid-action confirmation.
MCP strips it before API dispatch, retaining the existing idempotency fingerprints.
App-only draft synchronization and asset-based lipsync remain scoped to the UI's
intentional project selection and private recovery state.

Deploy the updated embedded UI with these MCP descriptors. Cached older widgets
fail closed on guarded writes and must reopen; never silently retry a refused
write or discard the saved operation. Refresh the published tool schemas and
verify a fresh ChatGPT widget. No backend migration or API contract change is
required. Local tests and bundle builds do not imply production activation.

# Expanding ChatGPT workflows

Tracking: [CRAFT-6457](https://linear.app/sync-labs/issue/CRAFT-6457).
Release is on hold while the next workflow is prepared alongside the cost display.
Merging a PR into this repository's `main` starts a production deployment.

## Translate & Dub: first integration

`dubbing_create` uses the existing public `POST /v2/generate`
contract. It sends one saved video asset and `dubParams` and returns the parent
generation ID. The API owns the linked dubbing job, final lip-sync submission,
billing, and recovery. The widget must not start a second generation when the
dubbing stage finishes. Poll `generations_get` for the parent ID and use
`projects_list-generations` for project history.

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
`generations_get` for manual checks and ten-second automatic updates.
Polling stops on terminal states, read errors or hidden documents. Foregrounding
an active card rechecks it. A known job ID in an uncertain submission error is
read back without replaying the write. Both MCP Apps and ChatGPT's legacy
bridge keep a bounded read timeout and a usable Check status action after errors.

Each check passes `include=progress`, so the API adds `progress` and `summary`
and `generations_get` lists both in its output schema; a field missing from that
schema never reaches the card. The card shows the input's picture with the job's
title and facts over it (dub languages, length, model), a step track from
`progress.phase` (queued, dubbing, visually dubbing, finishing; a lipsync skips
dubbing and reads lip syncing) and a progress bar with "N of M steps done" that
breaks down into done, processing and queued on hover. Those steps are
controller tasks, not camera shots. A finished generation plays in the card,
beside its original when the input was a video, with its recorded cost from
`generations_get-costs`. Every one of these fields is optional, so an API that
predates them leaves the card at its status and estimate. The preview loads from
the same `SYNC_CHATGPT_APP_RESOURCE_DOMAINS` origins as playback; an asset
thumbnail on another origin is blocked by the host and the card shows its
placeholder.

Time remaining is derived from `generationEstimate.estimatedFinishAt` and the
returned `serverTime`, advancing with a monotonic clock. Missing/invalid estimates
show unavailable; overdue jobs show a delay message instead of zero or a new ETA.
Terminal jobs hide the estimate. Playback links are exposed only after a fresh
authorized status read, and signed result URLs remain intact. `projectId` is
included in the safe generation projection for the exact Open in Sync fallback.
Link clicks use the host's `ui/open-link` request or legacy `openExternal` bridge,
so navigation works inside a sandbox without popup permission. Legacy navigation
disables redirect rewriting to preserve signed video URLs.

The card is built from the companion workspace's `GenerationStatusPanel`, using
actual `@sync/ui` cards, badges, buttons and skeletons, the Sync logo, Satoshi,
and shared light/dark tokens. `deploy/generation-status` contains its compressed
HTML plus source-commit and SHA-256 provenance; the loader verifies the bytes.
The resource CSP permits the bundled data font and no external connections.
The MCP image and npm package carry this artifact independently of Studio's bundle.
Deploy MCP and refresh the ChatGPT publisher/tool metadata so existing cached
descriptors acquire the resource link. The card appears in chat for conversational
submissions only. Embedded Studio keeps its existing progress overlay and result
controls without this card. Local protocol and browser fixtures do not establish
deployment or live ChatGPT rendering.

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

The embedded language form reads `dubbing_get-options`, an authenticated,
read-only tool whose lists come from the same public schema as submission. It
creates no job and makes no billing request. Older servers leave translation
unavailable; the form additionally requires a combined estimate breakdown.

## Chat and Studio draft selections

When an editable Studio is open, its model context includes the canonical
`projectId`, `draftId`, revision, editable status and current inputs. Use
`studio-drafts_get` to read the latest document before `studio-drafts_update`.
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

## Cards

`src/cards.ts` lists the other cards a chat shows inline. They are the same
packaged bundle as the generation status card (`deploy/generation-status`), each
served under its own resource (`ui://sync/card-<name>-v1.html`) with a
`sync-card` meta tag that tells the bundle which card to be. Every profile with
`supportsStatusCard` lists and reads them; a client that renders no card sees
neither the resources nor the tools that only show one.

| Card | Opens from | Calls |
| --- | --- | --- |
| price check | `generations_estimate-cost` | `account_get-usage`, then the create tool |
| jobs | `jobs_create-many` | `jobs_get-many` |
| translated audio preview | `translation-previews_create` | `translation-previews_get` |
| usage and balance | `account_show-usage` | `account_get-usage` |
| voices | `voices_show` | none |
| recent videos | `generations_show-recent` | none |
| shot review | `shots_review` | `shots_regenerate`, the status read, `shots_splice` |

A card opens only from a tool whose result the person asked to see. The model
calls `account_get-usage`, `voices_list` and `generations_list` for its own
checks, often several times in a turn, so those stay without a card; the three
`*_show` tools read exactly the same data under a name the model calls only when
the person asks to see it.

`generations_estimate-cost` repeats what it priced as `request`, and takes an
optional `create`: the create call the quote is for, without `idempotencyKey`.
The call must be the job the quote prices, or the quote is refused:
`dubbing_create` only with `workflow=translate-and-dub`, `lipsync_create` only
without it, and the same model (a call that names none gets the quoted one). The
quote echoes the call with an `idempotencyKey` made for it and, when it names no
project, a `projectCreationKey`, so a retry makes neither a second video nor a
second project. The price check
card's Create button runs the call with that key, so a card the host reloads can
never start the video twice; it then hands the result to the status card and
tells the model the generation's id. A quote without `create`, which is
what a chat with the previous schema sends, leaves the button asking the chat to
create it. `create` never reaches the API.

ChatGPT refuses a card's call to a tool that takes attached files, and
`lipsync_create` is one there. For a client with the Sync app, the quote
therefore echoes a lipsync call as `lipsync_create-from-assets`, the same job
through the entry point embedded views call. A lipsync that needs an input that
entry point does not take (a link, an attached file, `shots`, `speakers` or
`allowOverlappingFaces`) gets a quote without `create`, so the button asks the
chat. Other clients keep `lipsync_create`.

A `create` call that names an existing `projectId` is held to the rule the create
tools enforce: without `projectIntent=explicit`, or a project this user just
created, the quote is refused. The saved-assets entry point has no such check of
its own, so the quote is where it is made for a card.

`shots_review` opens the shot review card on a completed generation. It refuses
what `shots_regenerate` would refuse (timeline clips, several speakers, a script,
a length that differs from the video's), so nobody flags shots that cannot be
rendered again. It only
reads: it checks that the given shots cover the video from frame 0 to
`frameCount` and returns the first render, its source video and the shots. The
card keeps the review itself (flags, takes, picks) and tells the model each id
as it starts a take or builds the final video. It is behind `lipsync_planning`
like the other `shots_*` tools, so ChatGPT never lists it.

A card calls tools itself, so on card-only clients the tools in
`CARD_CALLED_TOOLS` carry `ui.visibility: ['model', 'app']`; app profiles reach
them through `WIDGET_CALLABLE_HOSTED_TOOLS`.

