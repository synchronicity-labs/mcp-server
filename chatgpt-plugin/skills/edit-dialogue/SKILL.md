---
name: edit-dialogue
description: Correct or remove selected spoken words in a single-speaker video with Sync Edit Dialogue, keeping the original speaker's voice and re-syncing the lips. Use for names, dates, numbers, pronunciation, and filler removal. Whole-script replacement, translation, and multi-speaker editing are outside this workflow.
---

# Edit spoken dialogue with Sync

Produce an audio preview of the user's targeted corrections or removals, then
an approved final video. Require a single-speaker source and explicit edits.
Never guess replacement wording or promise perfectly unchanged pixels/voice.

## Tools

Names are logical MCP names; upload helpers depend on client capabilities.

| Step | Tool |
| --- | --- |
| Check support and model | `get-dialogue-options`, `models_get` |
| Create the project | `projects_create` |
| Register or import source | `assets_create` |
| Upload source, when needed/supported | `assets_create-upload-url`, `upload-media`, `upload-dialogue-source` |
| Transcribe | `create-dialogue-transcription`, `get-dialogue-transcription` |
| Preview audio | `create-dialogue-preview`, `get-dialogue-preview` |
| Quote and create video | `estimate-dialogue-video`, `create-dialogue-video` |
| Track the result | `generate_get-generation` |

## Check support and save the source

Use an authenticated Sync MCP connection. Discover tools and read their current
schemas; names below are logical names and may have host prefixes. Start with
`get-dialogue-options` and confirm the transcription, preview, estimate, and final
video tools are available before creating resources. If unsupported, explain the
gap and offer [Sync](https://sync.so) or
[MCP setup](https://github.com/synchronicity-labs/mcp-server#connect-your-agent).
Do not substitute a guessed endpoint or a full-script voiceover.

Resolve the intended connected account and an explicitly selected project, or
create a new project with `projects_create`, a fresh UUID `id`, and
`defaultWorkflow: "edit_dialogue"`. Preserve that ID on retries. Matching names
and an active editor never authorize using an existing project. Pass the
selected/new `projectId` and `projectIntent: "explicit"` where supported.

Use an accessible saved VIDEO asset. For a media URL, register with
`assets_create`. Supported social links must finish importing first: retain the
same URL/project, respect `retryAfterMs` (15 seconds if absent), and repeat only
the pending import. Stop on terminal import errors; never use `importJobId` as
an asset ID.

For files, use `upload-media` only when exposed and the host can supply its file
input. Otherwise use `assets_create-upload-url`, PUT raw file bytes with the
matching Content-Type, and register the returned `url` through `assets_create`.
If uploads are unavailable, ask for an accessible media URL or saved asset.
A local path alone is not a remote video input. Reuse the saved asset thereafter.

## Transcribe and agree the changes

Call `create-dialogue-transcription`, then read that job with
`get-dialogue-transcription` until complete. If creation returns a canonical
`videoAssetId` for a copied source, retain it for all subsequent dialogue calls.
For an explicit Sync-storage source rejection, use `upload-dialogue-source`
once if supported and adopt its new asset ID before transcription. Other errors
do not justify copying the source or repeatedly retrying upload.

Use actual transcript word IDs. Show the relevant transcript context, resolving
the occurrence when the same word appears more than once. Express only approved
edits using the live schema, for example:

```json
[
  { "kind": "change", "wordId": "w35", "replacement": "Mia" },
  { "kind": "remove", "wordIds": ["w12", "w13"] }
]
```

These IDs are examples, not values to reuse. Add a pronunciation respelling only
when needed and agreed. Confirm the edit intent and permission to use the
speaker's voice before synthesis; honor an explicit permission already given.
If the source has multiple speakers or the request replaces the whole script,
explain the limit before unsuitable processing. Do not split a new script into
word edits to evade that limit. Whole-script replacement belongs to Lip Sync
with a selected voice; it does not automatically preserve the source voice.

## Create and review the audio preview

Audio synthesis may clone the source voice and incur charges separately from
final rendering. Disclose the preview charge or returned pricing information,
and obtain authorization for this stage before `create-dialogue-preview` unless
already covered. If no preview quote is available, say so; never label it free
or invent an estimate. Follow the tool's spending and voice-use requirements.

Retain the project, source, approved edits, and completed `transcriptionId`.
When `get-dialogue-options` advertises `keyedPreview`, persist a fresh preview
`idempotencyKey` before creation. Call `create-dialogue-preview` with the edits
and exactly one of `transcriptionId` or a valid `previousPreviewId` for a
deliberately reopened preview of the same source.

Save the preview job ID. Track it using `get-dialogue-preview` with the same
project and canonical source. Do not automatically replay ambiguous preview
creation. Reopen an identified job; an explicit retry, when supported, must use
the original key and identical inputs. Without a known job or safe recovery
path, explain uncertainty and stop instead of creating a duplicate.

Present the returned audio link for review. Disclose partial completion and
which edits failed. Revise or resolve failed edits before claiming success; if
the user accepts partial output, carry that exact scope into approval and use
only a preview eligible for final video. Do not claim to have listened unless
audio inspection actually occurred. Changed edits require a matching new preview.

## Quote, render, and deliver

Discover valid lip-sync models with `models_get`. Preserve a supported user
selection; otherwise prefer `sync-3` when returned. Resolve a different available
model if needed. Use the eligible preview's completed `dialogueEdit.id` as
`dialogueEditId` for `estimate-dialogue-video`, together with the same project,
source, model, and options intended for rendering. The transcription ID and
preview polling ID are not substitutes for this completed dialogue edit ID.

Show the preview, edits actually applied, model, and final video estimate.
Obtain approval for that preview and spending unless already covered; follow
any stricter tool contract. Changed preview, model, or options need a matching
estimate and authorization. Never disable server spending controls.

Persist a fresh final-generation `idempotencyKey` and the approved request.
Call `create-dialogue-video` once with the approved `dialogueEditId`, source,
project, model, options, and key. Immediately retain its generation ID and read
`generate_get-generation` for that ID, using `wait: true` when supported.
Respect server backoff and stop on `COMPLETED`, `FAILED`, or `REJECTED`. For a
long-running job, hand back its ID/status and a resume instruction within a
reasonable session window; a timeout is not failure or permission to resubmit.

Reconcile uncertain final submission using an identified job first, or the
original key and unchanged inputs only when the tool permits. Stop after one
reconciliation attempt if still uncertain. Never create another paid job merely
to check status or refresh an output URL.

Deliver the exact completed `outputUrl` unchanged and the generation ID; report
returned failure causes without claiming success. Keep resumable IDs and keys
with the task, and credentials and signed media links out of git/public logs.

For an explicitly requested raw stdio dialogue job, read
[the stdio reference](references/stdio.md).
