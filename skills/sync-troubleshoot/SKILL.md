---
name: sync-troubleshoot
description: "Diagnose and recover failed or interrupted Sync MCP workflows, including authentication, upload, billing, provider and job-state errors. Use for a specific failure or missing capability, with authorized feedback where exposed."
license: MIT
---

# Diagnose and resume Sync work

For “This generation timed out” or “Why can't this tool run?”, gather the exact
operation, returned error/status and known account/project/asset/job IDs. Do not
ask for credentials or upload private media to a public report.

- Authentication: reconnect the actual MCP connection through its OAuth/device
  flow. Another browser tab's login does not change that connection.
- Missing capability: inspect its current tools/options and profile. A local
  stdio feature or embedded Studio widget is not universally hosted.
- Invalid media or configuration: use the returned validation cause. Fix only
  the requested input; do not switch model, speaker, language or trim content
  without agreement.
- Concurrency: read current jobs and wait for capacity; repeated create calls do
  not clear the limit. Billing/plan errors need the returned account action,
  not guessed credits or retries under another account.
- Pending import/preparation: retain immutable source/project/request and honor
  backoff. A pending status is not a failed operation.
- Provider failure or uncertain admission: distinguish a known terminal failure
  from a lost response. Read the existing job, or reconcile the same key and
  inputs where supported. Never invent a new key to “recover”.
- Attachment/UI failure: recover saving or display of existing output; do not
  repeat translation, synthesis or generation.

Report the confirmed cause, actions actually taken and safe resume path. Leave
unknown facts unknown. Do not promise completion/ETA without evidence.

Where exposed and authorized by the user's request or invoked workflow and host
policy, send one redacted feedback report per problem after handling/stopping
the task. Include tool/error/job identity and useful reproduction context;
omit secrets, raw customer media and unnecessary personal information. The
ChatGPT profile does not expose the feedback tool. A feedback receipt does not
retry, cancel or repair the original job.

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `get-account-context`, `get-account-usage`, `generate_get-generation`, `generate_get-generations`, `assets_get`, `get-dialogue-options`, `get-speech-options`, `get-translation-options`, `send-feedback` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
