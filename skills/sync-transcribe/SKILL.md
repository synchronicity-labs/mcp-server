---
name: sync-transcribe
description: "Obtain timed speech transcripts from supported Sync video/audio sources. Hosted clients use saved-video dialogue transcription within its limits; standalone audio and windowed transcription require capable stdio tools."
license: MIT
---

# Transcribe a supported source

For “Transcribe this video” or “Get the words in this audio”, resolve the source
and desired transcript. Check actual capabilities first. Do not promise a
general-purpose multi-speaker transcription workflow on every connection.

On hosted clients, the available path uses saved single-speaker VIDEO dialogue
transcription. Check dialogue support, save/import the source into a deliberate
project, then create and read the same transcription job. If the server returns
a canonical copied videoAssetId, retain it for subsequent reads. Do not create
dialogue edits, synthesize the voice or render video just to return a transcript.
State its source/speaker limits before using an unsuitable source.

For independent AUDIO or VIDEO transcription and supported time windows through
stdio, read [the stdio reference](references/stdio.md). Validate the returned
schema's units and duration ceiling; do not silently transcribe only a prefix
or confuse milliseconds with seconds. A local path is not a Sync-hosted source.

Read the same returned job until completed or failed, respecting supported wait
and backoff. Return actual text, timed words and job/source identity as available.
Preserve server word IDs/timings rather than reconstructing them from guessed
speech. A transcript is not a finished subtitle export or translation.

If source storage is rejected, follow the advertised source-copy/upload recovery
once and adopt its new asset identity. Other errors do not justify repeated
uploads. If the connection has no viable source path, explain the limitation
and the supported upload/client route without inventing an endpoint.

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `get-dialogue-options`, `projects_create`, `assets_create`, `create-dialogue-transcription`, `get-dialogue-transcription` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
