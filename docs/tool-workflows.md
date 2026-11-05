# Tool workflows

How the hosted tools handle multi-step and paid workflows. Agents get the same
guidance from tool descriptions and the server instructions; this page is the
reference for people changing those tools. Moved out of the README, which covers
connecting a client.

## Translate and dub

`create-translate-and-dub` requires a saved video asset, accessible project,
model, target language and persistent idempotency key. Confirm the paid action
before calling it, then poll its generation ID through completion. The current
`generate_estimate-cost` response covers lip-sync only, not additional dubbing
charges. See the [workflow integration and release plan](chatgpt-workflows.md)
for the remaining combined-pricing and embedded UI work.

## Lipsync a timeline

`create-timeline-lipsync` reproduces a Studio timeline: one video and several
audio clips, each placed on a stretch of the video. A clip names its audio
asset, its `startTime` and `endTime` in seconds on the video, and optionally
`audioStartTime`/`audioEndTime` (the part of the audio file it plays) and a
`syncMode`. The tool sends each distinct audio asset once, as a `refId` input,
and each clip as a `segments` entry reading its part of that audio, with
`syncMode` as the segment's `optionsOverride.sync_mode`. Clips may come in any
order but must not overlap. Parts of the video no clip covers keep their
original picture and sound, which is how a "No lipsync" range is expressed.

A clip can pin the face it lipsyncs with `speaker`: either a point on the face
(`frameNumber`, `x`, `y`, the frame counted from the clip's first frame) or a
`faceTrackUrl` to a JSON file of one bounding box per frame of the clip, both
sent as the segment's `optionsOverride.active_speaker_detection` with
`auto_detect: false`, or `{ detect: true }` for automatic detection in that
clip, which Studio uses for clips too short to track. Studio sends clips with a picked speaker in frames, so a
clip may give `startFrame`/`endFrame` (end inclusive) instead of seconds.
Studio's "Do this with your agent" prompt for a timeline lists exactly these
clips. The ChatGPT app doesn't get the tool, since its embedded Studio has no
timeline.

## Scenes and stems (organizations with the feature)

`scenes_detect` and `stems_separate` call internal API routes behind
server-side feature flags (`studio-scene-detection` and `stem-separation`).
They are listed only when the active organization's `GET /v2/account`
`features` includes `scene_detection` or `stem_separation`, on the hosted
server and over stdio, and never in the ChatGPT app listing.
`src/account-features.ts` reads the features from the session's
`OrganizationSession` (the stdio process, or one hosted session). That's the
same field `organizations_select` and `get-account-context` write when they
read the account, so switching organizations changes what is listed, and
stdio clients get `tools/list_changed`. The session stamps kept features with the
organization and selection they were read for: a read that began before a
switch, or that answered for another organization, is not kept, and features
kept for another organization are read again. When the session has none for
the active organization, `tools/list` reads `/v2/account` as the selected
organization and keeps the answer under the same rule. An API without the field lists
neither. A failed read lists neither and keeps nothing, so the next list reads
again. A call is not refused when the tool is hidden: the API decides. It
answers a disabled flag with a bare 404, which the tools report as
`feature_not_enabled`. A coded 404, such as a missing asset, is passed
through unchanged.

`scenes_detect` reads `GET /v2/asset-metadata/scenes` first and calls
`POST /v2/asset-metadata/scene-detection` only when the status is
`not_requested` or `failed`, because a new request clears the stored scenes.
Scene frames are inclusive, like a timeline clip's `startFrame`/`endFrame`, so
a scene maps onto a clip as is. `endSeconds` is `(endFrame + 1) / fps`.

`stems_separate` reads `GET /v2/assets/{id}/separate-stems` first and starts a
job with `POST` only when there is none or the last one failed. It waits by
reading, since the start route allows 60 calls an hour. The source must be in
Sync storage (`stem_separation_source_not_hosted` otherwise). The tools don't
mix audio, so the agent lays a dub over `backgroundUrl` itself.

## Quote replacement speech

For “make this video say this script”, pass the replacement `script` to
`generate_estimate-cost` with the chosen `model` and source `fps` when known.
The MCP adapter estimates spoken seconds using Sync's speech-duration heuristic
(160 words/minute with CJK segmentation and a character-duration floor), then
requests pricing from the existing API. It does not synthesize or reserve credits.
A six-word greeting in a 30-second video therefore quotes approximately 2.25
seconds of lip-sync. Speech synthesis is excluded; actual speech length and
final cost can differ.

Once replacement audio exists, pass its measured `audioDuration` instead. This
wins over `script` and the legacy `duration` input. For videos, also pass
`videoDuration` and the generation's `syncMode` when using `cut_off` (shorter
input) or `silence` (longer input). Other modes follow the audio duration;
image inputs need only the script or audio duration. Set `visualType: "image"`
when quoting an image with any sync mode; images always follow speech duration
and must omit `videoDuration`.

The response preserves API pricing fields and adds `durationEstimate` with
`durationSeconds`, `audioDurationSeconds`, `source` (`script` or `audio`),
`approximate` and `excludesSpeechSynthesis`. Explain that basis when confirming
the generation. Requote changed scripts, audio, models or sync modes. Existing
explicit `duration` calls and combined translate-and-dub quotes keep their
existing behavior; translation still uses source duration.

Deploy the MCP service and refresh the ChatGPT tool catalog to expose the new
inputs. No embedded app bundle or API deployment is required for this adapter.

## Translate a social video link

For “Translate this YouTube link to Spanish”, use the existing asset and translation tools:

1. Select a project and call `assets_create` with the link, `type: "VIDEO"`,
   and `projectId`. YouTube, TikTok, Instagram and Facebook video links are supported.
2. A `409 import_in_progress` response includes `importJobId`, `importStatus`,
   `progress`, and `retryAfterMs`. Wait that interval (15 seconds if absent), then
   repeat the identical asset request. The API reuses the import and eventually
   returns the saved asset; no separate download or asset registration is needed.
3. Use the returned asset `id` as `videoAssetId`. Discover supported languages/models,
   estimate the translation, confirm its cost and configuration, then call
   `create-translate-and-dub` with `targetLang: "es"` and a persistent idempotency key.
   Poll the returned generation ID through completion.

Never submit translation while the import is pending or use `importJobId` as an
asset ID. Stop on import failure, disabled imports, unavailable service or import
limits, explain the returned reason and offer uploading a file. Account feature
flags, platform restrictions and daily import limits remain enforced by the API.

## Edit Dialogue

When the API exposes transcription and dialogue-edit endpoints, `get-dialogue-options`
enables the embedded timed-word editor. When transcription refuses a source URL
because it is not in Sync storage, `upload-dialogue-source` copies the accessible
saved video through the bounded upload pipeline and returns a new project asset.
Use that asset's ID for the remaining dialogue calls. The widget performs this
recovery when `get-dialogue-options` advertises `sourceUpload: true`, and retains
the uploaded selection through reload, preview, and generation. Other 422 errors
do not initiate an upload, and a rejected uploaded copy does not trigger another
automatic upload. `create-dialogue-transcription` and
`get-dialogue-transcription` obtain the single-speaker transcript. Users edit or
remove timed words, then explicitly request `create-dialogue-preview` and poll
`get-dialogue-preview`. The adapter reads the server-owned transcript and keeps
the original speaker voice. It does not accept a full replacement script or a
selected TTS voice.

`estimate-dialogue-video` and `create-dialogue-video` use the completed preview's
`dialogueEdit.id`, original video asset and project. The final generation retains
normal API admission, retiming, billing and idempotency. A lost preview creation
response must not be automatically retried. Reopening an identified preview is
read-only. Partial completion must be shown to the user.


## Studio view tools

This candidate adds authenticated chat delivery to the exact mounted Studio view
from [sync-api-v2 #7227](https://github.com/synchronicity-labs/sync-api-v2/pull/7227).
Backend success is separate from its pending/applied/blocked/failed display
receipt. Existing draft synchronization and paid-operation recovery remain in
place; these view tools do not generate or synthesize media.
Each model-callable view operation has its own tool, flat input schema and
annotations. The generic `request-studio-view-action` tool is no longer exposed.
Draft updates/saves, project/workflow switches, result selection and continuation
declare destructive effects; receipt
acknowledgements remain non-destructive. Cached Studio resources retain the
existing app-only registration and acknowledgement tools.

## Release notes

This candidate includes thumbnail-only asset previews and hosted-video recovery
for Edit Dialogue. It packages the merged expanded-Studio fixes from
[sync-api-v2 #7216](https://github.com/synchronicity-labs/sync-api-v2/pull/7216),
[#7220](https://github.com/synchronicity-labs/sync-api-v2/pull/7220) and
[#7222](https://github.com/synchronicity-labs/sync-api-v2/pull/7222) and
[#7233](https://github.com/synchronicity-labs/sync-api-v2/pull/7233): active draft
context publication, fullscreen height, draft/result controls and accessible
current-result navigation. The release follow-up
[#7253](https://github.com/synchronicity-labs/sync-api-v2/pull/7253) aligns all
workflow titles, removes the projects-header Resume shortcut, and keeps previews
above the composer. New lipsync/image-to-video requests default to `sync-3`;
saved drafts and retries retain explicit model choices. It retains all eleven UI resources published through
MCP #96 and the unchanged archive of the oldest October 2 resource. See
[frontend packaging](chatgpt-release.md) for the exact source commit,
checksums, release order and live acceptance requirements.

The existing workflow backend from PR #6822 is already in production. The draft
API is already published; the new Studio view API routes must be released before this MCP candidate.
Preparing the candidate does not deploy it or perform an EKS cutover.

## Embedded speech previews

When the API advertises durable `/v2/tts/jobs` creation and status endpoints,
ChatGPT can check `get-speech-options`, create a confirmed `create-speech-preview`
and read the same job with `get-speech-preview`. Creation requires a persisted
UUID idempotency key and is potentially paid. Reuse the key and identical input
only to reconcile uncertain admission. Never synthesize again because saving the
resulting audio asset failed. Project access and organization billing remain API
authority; options expose only the fields needed for the speech quote.

The compatible backend from sync-api-v2 PR #6822 is already in production.
The packaged frontend comes from the merged source recorded in its release
provenance. The candidate catalog retains eleven previous UIs; the retired October 2
resource is archived rather than served, as detailed in the release guide.
After the MCP release, rescan publisher metadata and verify preview, attachment,
reload recovery and playback in ChatGPT. Local and package checks do not establish
production acceptance; older APIs omit the speech tools and the UI fails closed.

## Embedded translation previews

With saved-asset support deployed on the existing `/v2/integrations/dubbing` API,
the server exposes
`estimate-translation-preview`, `create-translation-preview` and
`get-translation-preview`. These are separate from combined video dubbing.
Creation requires a stable UUID key and an authorized saved audio asset; the API
binds the key to immutable inputs before provider admission. A lost response
reuses the same key or known job ID. `recoveryRequired` never permits a fresh
paid request. Save/reconcile the resulting audio separately, then explicitly
lip-sync that saved audio rather than submitting another combined dub.

The API advertises versioned saved-source authorization and keyed recovery in
its OpenAPI contract. Existing route presence alone does not enable these tools.
Older APIs omit these tools; `get-translation-options.previewAvailable` reports
that distinction. Deploy API support before MCP, package the matching shared
Studio frontend, rescan, and verify the real ChatGPT workflow. Local fixtures
establish neither production release nor provider output quality.


## Account, usage and project rename

`get-account-usage` reads the connected organization's billing projection and,
for metered accounts, complete current-period usage. Available credits exclude
in-flight holds. Missing usage is unavailable, never a zero total. Billing
management requires an owner/admin role as well as the API billing flag.
`rename-project` changes only the name through the existing authenticated project
PATCH route; it cannot change visibility or submit work and never retries writes
automatically. Embedded clients keep the title read-only when older MCP
releases omit `get-account-context.capabilities.projectRenaming`.

`get-account-context` reads `/v2/oauth/account` for the connected account and
organization. API keys retain a null signed-in account. The UI must not infer a
personal asset scope or permissions from a client name or an API key's owner.

## Choose the organization

Every call runs in one Sync organization, and paid work is created and billed there.
Ask: “Generate this in the Acme org.”

1. `organizations_list` reads `GET /v2/account/organizations`: the organizations this
   credential can act in, with role and plan, marking the one this session runs in
   (`isCurrent`). A device-auth sign-in lists every organization the user belongs to.
   A Sync app connection (OAuth) lists the organizations ticked on the consent screen;
   each one gets its own grant, shown and revocable in that organization's settings.
2. `organizations_select {organizationId}` switches the MCP session: the stdio
   process, or one hosted session. Every later API call sends
   `x-sync-organization-id`, and the API checks membership on each one. It returns
   the new organization's plan, generation limits and feature flags. A refusal comes
   back with its API code and the API's `suggestion` as `nextStep`:
   `oauth_organization_not_granted` (reconnect Sync and tick that organization),
   `organization_access_denied` or `invalid_organization_id`. The same `nextStep`
   follows any call whose organization was refused, for example after a grant is
   disconnected mid-session. After a switch,
   stdio sends `notifications/tools/list_changed` so the client lists tools again.
3. To run one paid create elsewhere without switching, pass `organizationId` on the
   create and on its estimate (`create-lipsync`, `create-lipsync-from-assets`,
   `create-timeline-lipsync`, `create-translate-and-dub`, the translation preview and
   Edit Dialogue creates and estimates, `generate_estimate-cost`). The server reads
   `/v2/account` as that organization first and refuses before any paid work if the
   API doesn't answer for it. Reads of the ids that call returns stay in that
   organization for the rest of the session.

Create results include `organization` (`id`, `name`): the organization they ran in.
`get-account-context` names the active organization and its `features`, and
`organizationChoice` says whether the session chose it and how to switch.

API keys are bound to one organization. With `SYNC_API_KEY`, `organizations_list`
returns the key's organization, and selecting or passing another one is refused
without sending the header (the API would answer `api_key_organization_bound`). Sign
in with device auth to switch.

## Reusable voice cloning in ChatGPT

When the connected API exposes voice cloning, hosted clients can call
`voices_clone-voice`. Ask: “Save a reusable clone of my voice from this sample,
called My narration.” Confirm permission to clone the speaker, the sample and
the name before creating it. Plan limits and provider requirements still apply.

1. Upload an audio/video sample in Sync, or upload and register it with the asset
   tools. Reuse its `assetId`; alternatively provide a Sync-hosted `url`.
2. List existing voices first to avoid unnecessary duplicates. Clone with
   `name`, `provider: elevenlabs` and exactly one sample source.
3. Use the returned **`id`** as `voiceId` in `create-lipsync` with `script`.
   The separate provider-specific `voiceId` field is not the Sync identifier.
4. Review the video estimate and confirm generation separately.

This exposes the conversational tool flow, not a new clone form in the embedded
UI. It does not enable hosted voice deletion or standalone TTS. Edit Dialogue's
original-speaker previews remain a different workflow.

The API enforces sample validity, asset access, plan slots, provider access and
duplicate names. On a failed or lost response, do not automatically retry:
list voices, reconcile the result and explain uncertainty to the user. See
[voice-cloning acceptance](chatgpt-voice-cloning.md) before publication.
