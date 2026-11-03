---
name: talking-photo
description: Make a still photo, portrait, mascot, illustration or AI character talk with sync. labs, as a lip-synced video from a typed script (sync. labs voices it) or from the user's own audio. Use for "make this photo talk", "make this picture say…", a talking avatar or character, or animating a portrait with speech, including when the user has no picture yet and wants one created first. Not for moving video footage (lipsync-video), translation (translate-and-dub) or changing a few words in an existing video (edit-dialogue).
---

# Make a photo talk

Delivers one MP4 of the picture speaking the user's words.

## Inputs

- **Picture**: an image file in this conversation (uploaded, or generated here), a public image URL, or a Sync image asset ID. If the user has no picture, offer to create one with image generation first: one clear face, looking at the camera, mouth closed, head and shoulders, plain background.
- **Speech**: either a script, which needs a voice, or an audio file, audio URL or Sync audio asset.

Ask only for what is missing. Never invent the words the character says. If the user asks you to write them, draft a short script and get approval before quoting.

## Tools

| Step | Tool |
| --- | --- |
| Pick a voice (script only) | `voices_get-voices` |
| Quote | `generate_estimate-cost` |
| Create | `create-lipsync` |
| Wait for the result | `generate_get-generation` |

## Steps

1. **Voice.** For a script, call `voices_get-voices`. Unless the user named a voice, suggest two or three that fit the character, each with a few words on its style. Use the chosen voice's returned `id` as `voiceId`; never invent an ID.
2. **Quote.** Call `generate_estimate-cost` with `model: "sync-3"`, `visualType: "image"`, and either `script` or the measured `audioDuration`. Say that script quotes are approximate and exclude speech synthesis.
3. **Confirm.** Show the picture, the script or audio, the voice and the estimate, then wait for approval. Skip this only when the user already approved this exact request and cost.
4. **Create.** Call `create-lipsync` once with:
   - the picture as `image` (a file in this conversation), `imageUrl` or `imageAssetId`;
   - `script` with `voiceId`, or `audio`, `audioUrl` or `audioAssetId`;
   - `model: "sync-3"`;
   - a new `idempotencyKey` and a new random UUID as `projectCreationKey`;
   - a short `projectName` such as "Talking fox".

   Do not pass `projectId` for new work. If the response is lost, retry once with the same keys and inputs; never generate new keys for a retry.
5. **Wait.** Call `generate_get-generation` with the returned `id` and `wait: true`. If it is still pending, call it again with the same `id`. Never create a second generation to check progress.
6. **Deliver.** When the status is `COMPLETED`, give the exact `outputUrl`, unchanged. Offer one next step, such as another line, another voice, or dubbing it into another language.

## When something fails

- **The picture is rejected** (no clear face, several faces, too small): explain the reason and suggest a clearer head-and-shoulders picture.
- **Out of credits or over a plan limit**: explain the returned message plainly. Don't promote plans or pricing.
- **Any other error**: quote the returned message, say no video was created, and stop. Don't retry with different inputs unless the user asks.
