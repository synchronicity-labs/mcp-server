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
