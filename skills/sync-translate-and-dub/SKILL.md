---
name: sync-translate-and-dub
description: "Translate spoken video or saved audio with Sync, review translated speech, and optionally render matching lips. Use for language localization and dubbing, not subtitle-only output or text-document translation."
license: MIT
---

# Translate speech and render the result

For “Dub this video into Spanish”, resolve source media, target language and
whether the user wants a complete video or an audio preview first. Discover
supported source/target languages and model choices; never invent language codes.

Save the video in an explicitly selected or newly created project. Import social
links through the asset tool and wait for a saved VIDEO asset before generation.
Keep import URL/project stable, respect backoff, and stop on terminal failures.

## Complete video

Estimate the combined workflow with `workflow: "translate-and-dub"` when the
estimate schema supports it. Otherwise the lip-sync estimate is not the total:
disclose missing dubbing/provider charges and resolve authorization for them.
Confirm language, source, model and costs. Persist an idempotency key and, for
new-project creation, a projectCreationKey. Submit once with the saved video.
Read the returned generation ID through completion; the API owns both stages.
Do not create a second job to “finish” the dub.

## Review translated audio before video

Use the separate preview quote with an accessible audio asset/project. If quoted
duration is shorter than source duration, explain the limit and get agreement
before preparing a new shortened asset. Quote that saved asset; the estimate
does not trim the original. This path is not full-video translation unless the
whole source is included.

Confirm preview language and displayed cost. Persist a UUID preview key before
creation; retain the immutable request and job ID. Read the same preview job.
`recoveryRequired` means provider acceptance is uncertain, not permission to
create again. Save/register returned translated audio separately if needed;
attachment failure never justifies another translation.

Present translated audio for review. If video is then requested, estimate and
authorize a separate lip-sync using the saved translated audio. Do not send it
through the combined Translate & Dub tool again. Return exact completed media
URLs and make clear whether the result is audio, video, partial or pending.

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `get-translation-options`, `projects_create`, `assets_create`, `generate_estimate-cost`, `create-translate-and-dub`, `estimate-translation-preview`, `create-translation-preview`, `get-translation-preview`, `trim-audio`, `get-audio-trim`, `create-lipsync`, `generate_get-generation` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
