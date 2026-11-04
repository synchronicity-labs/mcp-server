---
name: sync-voices
description: "Find, select, inspect or explicitly clone permitted voices in Sync, and remove a selected saved voice where supported. Use for reusable voice management; targeted original-voice corrections belong to Edit Dialogue."
license: MIT
---

# Choose or manage a voice

For “Use my saved narrator” or “Save a clone of my voice”, distinguish selection
from persistent voice creation. List existing voices first. Use the returned
Sync `id` in generation tools; the provider-specific voiceId is a different ID.
Respect voice restrictions and organization limits.

For selection, resolve ambiguous matches and return the chosen voice/ID. Do not
clone a sample or change accounts as a side effect.

For an explicitly requested clone, confirm permission to clone the speaker,
the sample(s), and the saved name. Explain available billing/plan/provider limits;
do not claim cloning is free. Stage local samples through an actual upload path.
Supply exactly one permitted sample form according to the live schema: saved
asset, Sync-hosted URL, or supported sample-URL collection. Video samples may
have audio extracted by the API; do not upload repeatedly to provoke success.

Cloning is persistent and non-idempotent. Retain request and returned ID. After
a lost or failed response, list voices and reconcile before considering another
write. Never automatically retry creation, change sample/name, or switch accounts
to bypass provider, duplicate-name, or plan errors.

Return the saved voice identity and how it can be selected for speech/video.
A reusable clone is different from Edit Dialogue's original-speaker preview.
For inspecting or deleting a voice through local stdio, read
[the stdio reference](references/stdio.md). Resolve the exact voice and obtain
required deletion confirmation; absence from a hosted catalog is not permission
to guess a deletion endpoint.

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `voices_get-voices`, `voices_clone-voice`, `assets_create-upload-url`, `assets_create`, `upload-media` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
