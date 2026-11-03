---
name: translate-and-dub
description: Translate a video's speech into another language with sync. labs and re-sync the lips to the dubbed audio, from an uploaded video or a YouTube, TikTok, Instagram or Facebook link, into one or several languages. Use for "dub this video into Spanish", "translate my YouTube video to Japanese", AI dubbing, or localizing a video for other markets. Not for subtitles only, translating a text document, or lip-syncing audio the user already has (lipsync-video).
---

# Translate and dub a video

Delivers one dubbed MP4 per target language, with lips matched to the new audio.

## Inputs

- **Video**: a video file in this conversation, a Sync video asset ID, or a YouTube, TikTok, Instagram or Facebook link.
- **Target language(s)**: ask if none was given. Use `sourceLang: "auto"` unless the user names the spoken language.

## Tools

| Step | Tool |
| --- | --- |
| Check languages | `get-translation-options` |
| Create the project | `projects_create` |
| Save the video | `upload-media` (file) or `assets_create` (link) |
| Quote | `generate_estimate-cost` |
| Create | `create-translate-and-dub` |
| Wait for the result | `generate_get-generation` |

## Steps

1. **Languages.** Call `get-translation-options` and check that every requested language is supported. Name the closest supported option for any that is not.
2. **Project.** Call `projects_create` with a new random UUID as `id`, a short `name` and `defaultWorkflow: "translate_and_dub"`. Use the returned `projectId` with `projectIntent: "explicit"` in every later call.
3. **Save the video.**
   - **File:** call `upload-media` with `mediaType: "video"`.
   - **Link:** call `assets_create` with the URL, `type: "VIDEO"`, the `projectId` and `projectIntent: "explicit"`. A 409 `import_in_progress` means the import is running: wait `retryAfterMs` (15 seconds if absent) and repeat the identical request until it returns an asset. On `import_failed`, `import_not_enabled`, `import_unavailable` or a limit error, explain the reason, offer a file upload, and stop.

   Never pass an `importJobId` as an asset ID.
4. **Quote.** Call `generate_estimate-cost` with `workflow: "translate-and-dub"`, `model: "sync-3"` and the video's duration in seconds. Show the returned breakdown and say that any external voice-provider charges it lists are extra.
5. **Confirm.** Show the video, the language(s) and the estimate per language, then wait for approval, unless this exact request and cost were already approved.
6. **Create.** For each target language, call `create-translate-and-dub` once with `videoAssetId`, `targetLang`, `sourceLang`, `model: "sync-3"`, the `projectId` with `projectIntent: "explicit"`, and its own new `idempotencyKey`. On a lost response, retry that language once with the same key and inputs.
7. **Wait and deliver.** Poll `generate_get-generation` with each returned `id` and `wait: true` until it is `COMPLETED` or `FAILED`. Dubbing takes longer than plain lipsync, so tell the user it may take a few minutes. Give each exact `outputUrl`, unchanged, labelled with its language.

## Rules

- One paid job per language. Never resubmit a language to check progress.
- If a language fails, report it and keep the others.
- Don't offer subtitles, captions or a translated transcript as a substitute; this workflow produces dubbed video only.
