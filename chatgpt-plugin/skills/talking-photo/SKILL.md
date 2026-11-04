---
name: talking-photo
description: "Make a still image, portrait, mascot or character speak with Sync using audio or a script and an available voice. Use for talking photos; moving video and targeted dialogue corrections use other workflows."
license: MIT
---

# Make a picture speak

For “Make this mascot say welcome”, require one image and audio or an explicit
script. Ask only for missing inputs. If asked to write the words, draft them for
approval. Sync does not create the source image: use a separate available image
tool only when requested, or obtain an existing image.

Use a clear usable face. Save host attachments with the available upload bridge;
otherwise presign, PUT bytes and register the returned URL, or use a saved asset/
accessible URL. A local path is not a remote image. Retain asset IDs.

Discover a non-deprecated eligible lip-sync model; prefer `sync-3` when returned,
unless a supported model was selected. For script input, discover voices and use
the returned Sync `id`, not a provider's ID. Voice cloning is a separate explicit
request. Resolve unclear faces rather than fabricating coordinates.

Quote with `visualType: "image"` and measured `audioDuration` or the approved
`script`. Omit `videoDuration`: images follow speech duration. Script quotes
are approximate and exclude speech synthesis. Disclose unquoted synthesis cost.
Confirm the selected image, speech, voice, model and costs under the tool contract.

For new work, submit with a fresh persisted `projectCreationKey`, short
`projectName`, and `idempotencyKey`; retain both keys and exact input. An existing
project requires explicit selection and `projectIntent: "explicit"` where
supported. Do not select projects by matching names.

Call the creator with one image source and one audio source or script plus
voice. Track the returned generation ID with the status tool, using `wait: true`
when supported. On completion return the exact `outputUrl` and job ID. A rejected
image needs a clarified/replacement input, not repeated paid attempts.
Reconcile an uncertain response using its job ID or same-key identical request
only as permitted; stop if still uncertain. Never regenerate to refresh a link.

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `models_get`, `voices_get-voices`, `projects_create`, `upload-media`, `assets_create-upload-url`, `assets_create`, `generate_estimate-cost`, `create-lipsync`, `generate_get-generation` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
