---
name: sync-speech
description: "Create and review Sync speech audio from an approved script and available voice, then save or reuse it in video. Use for speech previews and supported stdio TTS; hosted previews do not promise standalone MP3 export."
license: MIT
---

# Create a speech preview

For “Let me hear this line in that voice before making the video”, require the
exact script, an available Sync voice ID and a deliberate project. Discover
speech availability and restrictions. Read options for current billing/allowance;
a free allowance is not proof that this particular request is free.

Select a voice returned by the voice tool; keep its Sync ID separate from the
provider ID. Do not clone a voice merely because none was selected. Confirm the
script, voice/settings and quoted or explicitly unquoted synthesis spending.

Persist a fresh UUID idempotency key and immutable project/script/voice/settings
before creating a preview. Save its job ID immediately. Read that same job until
SUCCESS or FAILED using the supported waiting behavior. Do not assume the video
generation status enum applies to speech jobs.

On success, deliver the returned playable URL exactly and retain duration/job ID.
Save/register/attach the audio as its own step when needed. Failure to attach or
save the result never permits resynthesis. An uncertain admission uses the same
key and identical input according to the tool contract. A changed script or voice
is a new potentially paid request with fresh authorization.

Hosted speech tools create previews for video input; do not promise a standalone
MP3 voiceover/export workflow there. For additional local stdio TTS tools, read
[the stdio reference](references/stdio.md). If that capability is missing, explain
the limitation instead of issuing a guessed API request.

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `get-speech-options`, `voices_get-voices`, `projects_create`, `create-speech-preview`, `get-speech-preview`, `assets_create` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
