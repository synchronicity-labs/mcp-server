---
name: sync-timeline-lipsync
description: "Lip-sync several timed audio clips or speakers on one video timeline with Sync. Use for segment placement, per-clip face selection and supported kept ranges; requires a client exposing the timeline tool."
license: MIT
---

# Lip-sync a timeline

For “Put these two lines at 3–5 seconds and 8–10 seconds”, require one source video,
audio assets and explicit clip placement. Discover the actual timeline schema
and its limits first. ChatGPT's current app profile omits this tool; explain that
boundary without substituting a whole-video render.

Read metadata when available. Resolve project and every distinct source asset.
Each clip must reference the intended audio and its placement on the video;
audio offsets are separate from video placement. Use consistent seconds or the
supported frame representation, respecting the returned frame convention.
Validate clip count, ordering, overlaps and bounds against the live schema.
Never discard or shift a clip silently to satisfy a limit.

Ask which face corresponds to each ambiguous speaker. Use a returned face track
or actual user-selected coordinates/frame; never invent them. For analyzed
speakers and short clips, follow the tool's current analysis/selection contract.
Account multispeaker capability and per-clip face selection are distinct.

When supported, preserve no-lipsync ranges and use the explicit whole-output audio
field only if requested. Uncovered ranges follow the tool contract; do not promise
that clip audio replaces the entire soundtrack. This is not general music mixing.

Quote using the actual billable output duration/model/options; if the estimator
cannot price the configuration fully, disclose that instead of inventing a sum.
Confirm the timeline, speakers, duration modes, project and spending. Persist
the approved request identity before submission.

Submit once. Track the same returned generation ID to completion and give its
exact output URL. Resolve invalid overlaps or unsupported options with the user
before a changed request. Recover uncertain submission only under the tool's
idempotency contract; never generate again for progress or UI display.

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `models_get`, `projects_create`, `assets_get`, `assets_create`, `create-timeline-lipsync`, `generate_estimate-cost`, `generate_get-generation` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
