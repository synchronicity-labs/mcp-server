---
name: media
description: "Upload, import, find, inspect, download, rename, share, delete or prepare media in Sync. Use for asset-library work and supported prefix audio trimming, not general video editing."
license: MIT
---

# Work with Sync media

For “Upload this clip and find my voiceover”, resolve the intended organization,
project, source and action. Search with narrow filters and small page limits.
Paginate using returned cursors; a page is not the whole library. Creator/account
filters need verified identity; an API key has no personal signed-in account.
The Studio widget owns `get-asset-creators`; it is not a conversational action.

## Save and inspect

Use the host upload bridge only when available and with its required file
object. Otherwise request a presigned URL, PUT raw bytes with the matching
Content-Type, then register the returned final URL as an asset. Confirm upload
completion before registration; a path or signed uploadUrl is not an asset ID.

Register public media URLs or import supported social links with the deliberate
project and correct asset type. A pending import retains the same URL/project,
respects retryAfterMs (15 seconds when absent), and yields a saved asset only
on completion. Do not use importJobId as assetId. Stop on terminal import/limit
errors and offer file upload. Retain durable asset IDs for later steps.

Inspect asset details and available playback metadata without inventing unknown
duration, frame rate or dimensions. Use only the returned thumbnail for that
asset, or the documented placeholder when unavailable. Do not substitute stock/
generated images. Copy download URLs exactly; fetching a fresh link does not
require generating new media.

## Change or prepare

Resolve the exact asset for an explicit rename, visibility change or deletion.
Change only requested fields; visible media is not necessarily writable. Explain
authorization failures without retrying under another identity. Respect tool
confirmation requirements before deleting.

Prefix trimming creates a new saved audio asset; it does not alter the original
or produce video. Explain and confirm the shortened duration before preparation.
Persist an idempotency key, poll the same trim, then use its returned asset and
actual duration for a new generation quote. It is not arbitrary interval trimming.
A failed operation needs an explicit changed/new attempt, not an automatic loop.

Report saved/changed/deleted IDs or exact download links, clearly distinguishing
completed, pending and failed work. For stdio batch asset lookup, read
[the stdio reference](references/stdio.md).

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `assets_create-upload-url`, `assets_create`, `upload-media`, `open-upload-widget`, `assets_get-all`, `assets_count`, `assets_get`, `get-playback-metadata`, `assets_get-download-url`, `assets_update`, `assets_delete`, `trim-audio`, `get-audio-trim` |
| Widget-owned creator filter (not model-callable) | `get-asset-creators` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
