---
name: lipsync-video
description: Lip-sync an existing video to new speech with sync. labs, from a voiceover, a re-recorded take, a song, or a typed script that sync. labs voices, including AI-generated clips and YouTube, TikTok, Instagram or Facebook links. Use for "lipsync this video to this audio", "make him say…", "match the lips to my voiceover" or "sync this clip to the song". Not for still pictures (talking-photo), translating speech into another language (translate-and-dub) or changing a few words in the original voice (edit-dialogue).
---

# Lipsync a video

Delivers one MP4 of the video with lips matched to the new speech.

## Inputs

- **Video**: a video file in this conversation, a public video URL, a Sync video asset ID, or a YouTube, TikTok, Instagram or Facebook link.
- **Speech**: an audio file, audio URL or Sync audio asset, or a script plus a voice.

Ask only for what is missing. Never invent the words.

## Tools

| Step | Tool |
| --- | --- |
| Save files from the chat | `upload-media` |
| Import a social link | `projects_create`, `assets_create` |
| Pick a voice (script only) | `voices_get-voices` |
| Quote | `generate_estimate-cost` |
| Shorten long audio | `trim-audio`, `get-audio-trim` |
| Create | `create-lipsync` |
| Wait for the result | `generate_get-generation` |

## Steps

1. **Save files.** For each file in this conversation (the video, or the user's audio), call `upload-media` once with `mediaType` `video` or `audio`. Use the returned asset IDs from here on, including for every retry; a file re-sent later becomes a different asset.
2. **Social links.** Create a project first with `projects_create`, using a new random UUID as `id`, a short `name` and `defaultWorkflow: "lipsync"`. Then call `assets_create` with the link, `type: "VIDEO"`, that `projectId` and `projectIntent: "explicit"`.
   - A 409 `import_in_progress` means the import is still running. Wait `retryAfterMs` (15 seconds if absent) and repeat the identical request until it returns an asset.
   - On `import_failed`, `import_not_enabled`, `import_unavailable` or a limit error, explain the reason, offer a file upload instead, and stop.
3. **Voice.** For a script, call `voices_get-voices`, suggest two or three fitting voices unless one was named, and use the returned `id` as `voiceId`.
4. **Length.** If the audio is noticeably longer or shorter than the video, ask how to handle it, and pass the answer as `options.sync_mode`:
   - `cut_off`: trim the longer one to match
   - `loop`: repeat the video from the start
   - `bounce`: play the video forward, then in reverse
   - `silence`: keep the video silent where the audio runs out
   - `remap`: speed up or slow down the video to match the audio

   If the audio is over a length limit, offer `trim-audio` to keep its first part, then quote again.
5. **Speakers.** If more than one face is visible, ask which person should speak. Leave `options.active_speaker_detection` unset unless the user picks a speaker.
6. **Quote.** Call `generate_estimate-cost` with the model (default `sync-3`) and the measured `audioDuration`, or the `script` for script input. For `cut_off` or `silence`, also pass `videoDuration` and `syncMode`. Label script quotes approximate and say speech synthesis is excluded.
7. **Confirm.** Show the video, speech, voice, any sync mode and the estimate, then wait for approval, unless this exact request and cost were already approved.
8. **Create.** Call `create-lipsync` once with:
   - the video as `videoAssetId` (saved or imported above) or `videoUrl`;
   - the speech as `audioAssetId`, `audioUrl`, or `script` with `voiceId`;
   - the model and any `options`;
   - a new `idempotencyKey`.

   For a project you just created in step 2, pass its `projectId` with `projectIntent: "explicit"`. Otherwise pass a new random UUID as `projectCreationKey` and a short `projectName`. On a lost response, retry once with the same keys and inputs.
9. **Wait and deliver.** Poll `generate_get-generation` with the same `id` and `wait: true` until `COMPLETED` or `FAILED`. Give the exact `outputUrl`, unchanged, and offer one next step.

## Rules

- Use `sync-3` unless the user picks another model; take model names only from `models_get`.
- Never reuse an older project unless the user explicitly asks for it.
- Never start a second paid generation to check progress or to refresh a result.
