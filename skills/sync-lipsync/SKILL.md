---
name: sync-lipsync
description: Lip-sync an existing video to supplied audio or a new script with Sync. Use for voiceovers, re-recorded takes, songs, or making a video say new words. Targeted corrections in the original voice belong to Edit Dialogue; translation and talking photos are separate workflows.
---

# Lip-sync a video with Sync

Deliver a completed video whose lips match the user's replacement speech.
Require one video plus one audio performance, or a script and an available
voice. Ask only for missing inputs; never invent the script.

## Tools

Names are logical MCP names; optional helpers depend on client capabilities.

| Step | Tool |
| --- | --- |
| Discover models and voices | `models_get`, `voices_get-voices` |
| Create the project | `projects_create` |
| Register or import media | `assets_create` |
| Upload files, when supported | `assets_create-upload-url`, `upload-media` |
| Read metadata, when available | `assets_get`, `get-playback-metadata` |
| Quote and create | `generate_estimate-cost`, `create-lipsync` |
| Track the result | `generate_get-generation` |
| Widget-owned submission (not model-callable) | `create-lipsync-from-assets` |

The Studio widget owns its saved-asset submission action; conversation uses
`create-lipsync` and must not manufacture a widget request.

## Discover and prepare

Use an authenticated Sync MCP connection. Discover tools and read their current
schemas; names below are logical names and may have host prefixes. If a needed
tool is missing, explain the gap and point to
[Sync MCP setup](https://github.com/synchronicity-labs/mcp-server#connect-your-agent).
Do not guess endpoints or require an embedded Studio widget.

1. Resolve the intended account if several are connected. Call `models_get` and
   choose a non-deprecated lip-sync model. Preserve a supported user selection;
   otherwise prefer `sync-3` if returned. If unavailable, resolve a supported
   choice rather than inventing a model name.
2. Default new work to a new project. Create one with `projects_create`, a fresh
   UUID `id`, a short name, and `defaultWorkflow: "lipsync"`. Preserve the ID on
   retries. Reuse an existing project only when explicitly selected by the user;
   matching names or an open editor do not select it. Pass `projectId` and
   `projectIntent: "explicit"` where supported for this selected/new project.
3. Resolve the media:
   - Saved assets: use their durable IDs; verify access as needed with `assets_get`.
   - Direct media URLs: use the URL inputs accepted by `create-lipsync`.
   - Local files: use `upload-media` only if exposed and the host can supply its
     required file object. Otherwise call `assets_create-upload-url`, PUT raw
     bytes to its `uploadUrl` with the matching Content-Type, then register its
     returned `url` through `assets_create`. If the host cannot upload, request
     an accessible URL or saved asset. Never send a local path as a remote URL.
   - Supported social links: call `assets_create` with the project, URL, and
     `type: "VIDEO"`. On `import_in_progress`, respect `retryAfterMs` (15 seconds
     if absent) and repeat the identical import request. Stop on terminal import
     errors and offer file upload. An `importJobId` is not an asset ID.
4. For scripts, use `voices_get-voices` and the returned Sync voice `id` as
   `voiceId`. Resolve an unspecified voice with the user. Do not create a new
   voice clone as an implicit part of selecting a voice.

Save returned asset IDs and reuse them. Inspect available metadata through
`assets_get` or `get-playback-metadata`; do not invent durations. If several
faces make the speaker ambiguous, resolve the intended person before submission.
Do not invent face coordinates or enable a speaker-selection option without
the user's intent.

## Quote and submit

For a material audio/video length mismatch, resolve a supported `sync_mode`:
`cut_off` ends at the shorter input; `loop` repeats video; `bounce` alternates
forward/reverse; `silence` preserves the longer duration, with silence after
audio ends; `remap` adjusts video timing to audio. Explain the relevant choice
and avoid silently trimming the user's content. Respect model and account limits.

Call `generate_estimate-cost` with the chosen model and measured `audioDuration`,
or the replacement `script` when audio does not yet exist. Use `videoDuration`
and `syncMode` for `cut_off` or `silence`. Do not quote the full source video
duration for a shorter replacement performance. Label script estimates as
approximate and disclose that speech synthesis is excluded. Show returned
amounts/units without inventing prices or a total for unquoted stages.

Show the source, speech/script, voice if any, model, duration handling, and costs.
Get approval before paid work unless existing authorization already covers this
configuration and spending; follow any stricter tool contract. Disclose and
resolve authorization for excluded synthesis charges. Requote changed inputs.
Never change server spending controls to bypass confirmation.

Before submission, retain the exact approved inputs, selected project, account,
and a fresh `idempotencyKey` in resumable task context. Do not store credentials.
Call `create-lipsync` with exactly one video source and one audio source or
`script` plus `voiceId`, the model, approved options, project, and key. Do not
pass equivalent URL/asset aliases together.

## Track and deliver

Retain the returned generation ID immediately. Use `generate_get-generation`
with that ID; use `wait: true` if supported and respect server backoff. Continue
until `COMPLETED`, `FAILED`, or `REJECTED`, within a reasonable interactive
session window. If still pending at handoff, give the ID, status, and a resume
instruction. Do not invent completion time.

On an uncertain submission response, recover using a returned job ID first.
Only retry creation when the tool contract permits, with identical inputs and
the original idempotency key; stop after one reconciliation attempt if still
uncertain. A new paid request needs new authorization. Status checks and expired
result links never justify starting another generation.

On completion, return the exact `outputUrl` unchanged and the generation ID.
On failure, report the returned reason and a practical next action. A submitted
job is not a completed video. Preserve signed URL strings exactly and keep them
out of repository files and public logs.
