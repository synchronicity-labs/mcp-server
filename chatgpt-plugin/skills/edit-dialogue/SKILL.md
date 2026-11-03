---
name: edit-dialogue
description: Change or remove a few spoken words in a single-speaker video with sync. labs, keeping the speaker's own voice and re-syncing the lips. Use for fixing a misspoken word, a wrong name, number, price or date, a mispronunciation, or cutting a filler word or phrase without reshooting. Not for replacing a whole script (lipsync-video with a script), translation (translate-and-dub) or switching to a different voice.
---

# Fix spoken words

Delivers one MP4 where only the agreed words change. Everything else keeps the original picture and voice.

## Inputs

- **Video**: a single-speaker video, as a file in this conversation, a public URL or a Sync video asset ID.
- **The fix**: which words to change or remove, and what to say instead. Never guess the replacement words.

## Tools

| Step | Tool |
| --- | --- |
| Check support | `get-dialogue-options` |
| Create the project | `projects_create` |
| Save the video | `upload-media`, `assets_create`, `upload-dialogue-source` |
| Transcribe | `create-dialogue-transcription`, `get-dialogue-transcription` |
| Preview the new audio | `create-dialogue-preview`, `get-dialogue-preview` |
| Quote | `estimate-dialogue-video` |
| Create | `create-dialogue-video` |
| Wait for the result | `generate_get-generation` |

## Steps

1. **Support.** Call `get-dialogue-options`. If Edit Dialogue isn't available, say so and stop. Note whether it advertises `keyedPreview`.
2. **Project.** Call `projects_create` with a new random UUID as `id`, a short `name` and `defaultWorkflow: "edit_dialogue"`. Pass the returned `projectId` with `projectIntent: "explicit"` in every later call.
3. **Save the video.** For a file, use `upload-media` with `mediaType: "video"`. For a URL, use `assets_create` with `type: "VIDEO"` and the project.
4. **Transcribe.** Call `create-dialogue-transcription`, then `get-dialogue-transcription` with the returned `id` until it completes. If the transcription result includes a `videoAssetId`, the video was copied into Sync storage: use that ID for every later step.
5. **Agree the edits.** Show the transcript lines around the fix. Turn the request into edits that use the transcript's word IDs:
   - `{ "kind": "change", "wordId": "w35", "replacement": "Mia" }`, adding `"pronunciation": "Meeah"` only for a name the voice might say wrong;
   - `{ "kind": "remove", "wordIds": ["w12", "w13"] }`.

   Confirm the edits, and confirm the user has permission to use this speaker's voice.
6. **Preview.** Call `create-dialogue-preview` with the edits and `transcriptionId`, plus a new `idempotencyKey` if `keyedPreview` is advertised. Poll `get-dialogue-preview` until it completes. If some edits failed, say which ones; don't present it as fully successful.
7. **Quote.** Call `estimate-dialogue-video` with the completed preview's ID as `dialogueEditId` and `model: "sync-3"`. Show the estimate and wait for approval of the preview and the cost.
8. **Create.** Call `create-dialogue-video` once with the same `dialogueEditId`, `model`, project and a new `idempotencyKey`. On a lost response, retry once with the same key and inputs.
9. **Wait and deliver.** Poll `generate_get-generation` with the returned `id` and `wait: true`. Give the exact `outputUrl`, unchanged.

## Limits

- One speaker only. If several people talk, say so before transcribing.
- Targeted words only. If the user wants a whole new script, explain that this keeps the original recording, and offer lipsync-video with a script and a chosen voice instead.
- Never split a new script into many word edits to get around this limit.
