# Claude full tool acceptance — October 15, 2026

This is pre-release evidence, not permission to merge, deploy or publish.

## What was actually tested

Earlier acceptance established tool discovery and smoke reads, plus one hosted
Claude web generation. It did **not** exercise every advertised tool. This pass
uses the actual Claude Code 2.1.251 client with its own fresh HTTP/OAuth login,
the 0.2.0 npm tarball installed in an isolated prefix, and the production Sync
API at image `f330477`. The candidate server runs on localhost; no candidate
code has been deployed. Claude's initialization records show exactly 25 Sync
tools, with embedded app presentation disabled.

The initial runtime is PR #78 `3b11d6e`; the dialogue input correction is
`f90dbc8`. After rebuilding and reinstalling the tarball, Claude successfully
submitted the corrected word-change schema on its first attempt. Other tool
handlers are unchanged by that correction. This is complete catalog coverage
through Claude Code HTTP, not a claim that all 25 were clicked in Claude web or
that every model, language and optional argument combination was tested.

The user approved a $2 total Sync/provider cap and short samples. Tests use the
user's own recorded sample: a normalized three-second speech extract, a short
original sample for a reusable test voice, and a dedicated private test project.
Full media URLs, credentials and account IDs are retained only in private evidence.

## Coverage

| Tool | Live result |
| --- | --- |
| `get-account-context` | Authenticated identity and selected organization verified before writes. |
| `models_get` | Seven models returned. |
| `get-dialogue-options` | Timed-word editing available. |
| `get-translation-options` | 110 translation targets returned. |
| `voices_get-voices` | Library read and newly cloned Sync voice ID verified. |
| `voices_clone-voice` | Own short recording cloned once; persisted voice returned by library reads. |
| `projects_create` | Client-chosen UUID creates a private project; HTTP replay resolves the same project. |
| `projects_get` | Same project read successfully. |
| `projects_get-all` | Search/list returned accessible projects. |
| `projects_get-generations` | Project history returned successfully. |
| `assets_create-upload-url` | Audio/video upload destinations issued. |
| `assets_create` | Uploaded audio/video bytes registered and read back. |
| `assets_get` | Exact saved media and metadata verified. |
| `assets_get-all` | Accessible asset listing/filtering verified. |
| `generate_get-generations` | Generation history returned successfully. |
| `generate_estimate-cost` | Lip-sync and translation quotes obtained before paid creation. |
| `create-lipsync` | Cloned-voice script generation completed; output downloaded and fully decoded. |
| `create-translate-and-dub` | English-to-Spanish generation completed; output downloaded and fully decoded. |
| `generate_get-generation` | Same accepted generation IDs polled to completion. |
| `create-dialogue-transcription` | Short speech transcription completed; cached-source reuse also exercised. |
| `get-dialogue-transcription` | Completed timed-word transcript read successfully. |
| `create-dialogue-preview` | Removal and word-change previews completed; corrected schema accepted first try. |
| `get-dialogue-preview` | Same preview jobs read to completion; removal WAV fully decoded. |
| `estimate-dialogue-video` | $0.30 quote returned for the completed expansion preview. |
| `create-dialogue-video` | Final dialogue video completed; H.264/AAC output downloaded and fully decoded. |

The parent acceptance harness performs the actual PUT of local media bytes to
Claude-issued upload destinations. Claude calls the asset tools before and
after those transfers. This proves the staged upload API workflow; it does not
claim that a Claude chat attachment is automatically uploaded by the connector.

## Completed media and budget

All three accepted video generations reached `COMPLETED` through Claude tool
reads and downloaded successfully. Full FFmpeg decode passed with both video
and audio streams at 640×360: cloned-voice lip-sync 1.52 seconds, Spanish dub
2.96 seconds, and final dialogue video 2.836 seconds. The removal preview WAV
also decoded successfully. These are transport/pipeline/media-integrity checks,
not a subjective voice-quality or Spanish translation-quality rating.

Pre-submission Sync quotes totaled **$0.98**: $0.32 lip-sync, $0.36 translation
(including $0.04 dubbing), and $0.30 final dialogue video. The script's separate
TTS usage event reports **$0.0064**. Preview cost signals record 331 synthesized
characters across 11 candidate takes, one three-second separation, and cached
separation/voice reuse on the later previews. The first removal did synthesize
its surviving neighbours; removal does not imply zero provider spend.

At published provider rates, preview TTS and separation add about $0.029:
[ElevenLabs API rates](https://elevenlabs.io/pricing/api) and
[fal Demucs](https://fal.ai/models/fal-ai/demucs). Short transcription adds
less than one cent at the published speech-to-text rate. A conservative total
reservation is **$1.10**, below the user's $2 cap. This is a budget estimate,
not a final provider invoice: preview rows have no settled usage-report amount.
No additional paid tests are needed or scheduled. Read-only project reconciliation
found exactly three video generations, matching the three submitted actions.

## Findings and negative cases

- The original generated `edits` schema exposed opaque items. A request using
  `type` rather than `kind` reached API validation and was rejected. The candidate
  now publishes explicit `change`/`remove` variants, examples and batch limits,
  and rejects malformed edits before any upstream request. Six new regression
  cases cover discovery, valid removal and invalid payloads; the full local
  suite has 583 passing tests across 43 files.
- The first short clip was mostly silence and returned terminal `NO_AUDIO`.
  A speech-containing extract completed transcription. The rejection is retained
  as evidence and is not counted as a successful transcription.
- A removal preview and a shorter word replacement both completed but were
  rejected by the production final-video retiming guard (422). No final paid
  generation was submitted for those previews. The rejection is preserved;
  a small phrase expansion is used to exercise the supported final-video path.
- Accepted jobs are polled by their original IDs. No ambiguous submission was
  retried, and paid generation keys are saved before submission.

## Tool parity and remaining scope

`create-lipsync` **is available to Claude**; the live cloned-voice script test
above invokes it. It accepts saved asset IDs, public URLs or script plus voice.

`upload-media` is implemented against ChatGPT's host-provided attachment fields
(`download_url`, `file_id`, MIME type and filename) and `openai/fileParams`.
There is no tested Claude attachment adapter in this release. Claude instead
has the upload-URL → byte-transfer → asset-registration path tested above.
Native Claude attachment upload remains a separate feature gap.

`create-lipsync-from-assets` is an embedded-app-only alias for the same lip-sync
handler, created so app calls can avoid ChatGPT attachment parameters. With
Claude embedded UI disabled it is intentionally hidden; it adds no generation
capability beyond `create-lipsync`. The other hidden tools are ChatGPT app and
upload-widget launchers. Candidate catalogs contain 29 ChatGPT tools and 25
Claude tools; deployed catalogs have 28 and 24 respectively.

Claude embedded UI, native attachment ingestion, Anthropic directory submission,
and approval to merge/publish remain outside this completed-tool test claim.
See [release gates](claude-release-0.2.0.md) for publisher setup and the separate
ChatGPT post-OAuth navigation caveat.
