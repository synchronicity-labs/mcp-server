---
name: generations
description: "Find Sync generation history, check progress, retrieve results or continue from original inputs/completed output. Use for job recovery and supported output rename/deletion, not starting a new paid generation just to check status."
license: MIT
---

# Find or resume generation work

For “Where is the video I started?” or “Use that result as the next source”,
resolve the organization, project or generation. List narrow pages of history,
prefer project history when the project is known, and ask which match if ambiguous.
A pending page or missing result does not prove no generation exists.

Read the selected generation ID. Use wait: true when supported and respect the
returned status/error and backoff. Stop on terminal status or hand back the ID
and current state after a reasonable session window. Never submit another
generation to check progress. Do not invent an ETA.

When complete, copy the exact output URL and record the generation ID. If a link
expires, read the same accessible result or use the supported download lookup.
Do not reconstruct signatures or regenerate media.

For continuation, read the original inputs and distinguish reuse of those inputs
from using the completed output. Resolve the user's intent; a failed/pending job
has no completed output to reuse. Preserve the chosen source and project context.
Staging a draft is separate from paid submission, which needs a matching quote
and authorization. Existing dialogue/translation output should not silently
repeat synthesis or dubbing.

For local stdio count, direct generation read, result-download, output filename
change and deletion, read [the stdio reference](references/stdio.md).
Deletion requires an explicit confirmed target and permissions; it is not job
cancellation. Return actual pending/completed/failed status and a safe resume
instruction. Backend results alone do not prove they appeared in Studio.

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `generate_get-generations`, `projects_get-generations`, `generate_get-generation`, `get-generation-continuation`, `assets_get-download-url` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
