# Jobs: `jobs_get`, `jobs_wait` and many jobs at once

Sync work runs as jobs of several kinds, and each kind has its own read tool with its
own idea of "done". `jobs_get` and `jobs_wait` read and wait on all of them the same way.
They are on the local (stdio) server only, and both are listed with every toolset.

| Tool | Does |
| --- | --- |
| `jobs_get` | Reads the job once. |
| `jobs_wait` | Waits on the server until the job finishes or about 50 seconds pass, then returns its latest state. It sends `notifications/progress` while waiting when the call has a `progressToken`. If the job is still running, call it again with the same input. |

Both take `{kind, id, projectId?, projectIntent?}`. `kind` lists only the kinds this
server can read, because each kind reads through its own tool:

| `kind` | `id` | Reads through |
| --- | --- | --- |
| `generation` | the id a create tool returned (`lipsync_create`, `dubbing_create`, `lipsync_create-timeline`, `dialogue-videos_create`) | `generations_get`, with `include=progress` when the API offers it |
| `transcription` | the transcription id | `transcriptions_get` |
| `speaker_analysis` | the transcription id | `transcriptions_get-speaker-analysis` (once the API publishes it) |
| `translation_preview` | the `translation-previews_create` id; `projectId` is required | `translation-previews_get` |
| `import` | the social video link passed to `assets_create`, with the same `projectId` (and `projectIntent` if that call needed it) | `assets_create`, repeated with the same input; the API reuses the running import |
| `batch` | the batch id `batches_create` returned | `batches_get`; a finished batch's `result.results` lists each item's generation |

The kind's own read tools keep working as before, including their `wait: true`.

## Result

```json
{
  "kind": "generation",
  "id": "…",
  "status": "PROCESSING",
  "progress": 42,
  "estimatedFinishAt": "2026-11-05T10:00:00Z",
  "retryAfterMs": 15000,
  "result": { "…": "the job as the kind's own read tool returns it" }
}
```

- `status` is the unified status below. `result` keeps the API's own status.
- `progress` is the percent complete (0 to 100) while the job runs, when the API reports
  it: a generation's worker progress, an import's download progress, or the share of a
  batch's generations that have finished.
- `estimatedFinishAt` is the API's completion estimate for a running generation
  (`generationEstimate.estimatedFinishAt`), when it has one.
- `retryAfterMs` is the pause the API asked for before reading again (imports only).
  `jobs_wait` already honours it.
- A completed import's `result` is the saved asset; its `id` is the asset id. While an
  import runs, `result` holds `code`, `message`, `importJobId`, `importStatus` and
  `progress`. A failed or refused import's `result` is `{error: {message, status, code}}`.

## Status mapping

`PENDING` and `PROCESSING` mean the job is still running. The other four are final.

| Unified | generation | transcription | speaker_analysis | translation_preview | import | batch |
| --- | --- | --- | --- | --- | --- | --- |
| `PENDING` | `PENDING` | `PENDING` | | `PENDING` | 409 `import_in_progress` with `importStatus: queued` | `PENDING` |
| `PROCESSING` | `PROCESSING` | `PROCESSING` | `processing` | `PROCESSING`, `COMPLETING` | 409 `import_in_progress` (downloading, processing) | `JOBS_CREATED`, `PROCESSING`, `FINISHING` |
| `COMPLETED` | `COMPLETED` | `COMPLETED` | `completed` | `COMPLETED` | the asset is returned | `COMPLETED` |
| `FAILED` | `FAILED` | `FAILED` | `unavailable` | `FAILED` | `import_failed`, `import_download_failed`, `import_upload_failed`, `import_processing_failed` | `FAILED` |
| `REJECTED` | `REJECTED` | | | | `import_not_enabled`, `import_unavailable`, `import_daily_limit_reached`, `import_invalid_url`, `import_unsupported_platform`, any other `import_*` code | |
| `CANCELED` | `CANCELED`, `CANCELLED` | | | | `import_cancelled_by_user` | |

Statuses are matched without regard to case. An unknown status counts as `PROCESSING`,
so a wait keeps going rather than reporting a result that may not exist. A payload with
no status counts as `COMPLETED`, as the per-kind waiters always did. Errors that are not
about the job itself (authentication, the project-intent guard, the network) stay tool
errors.

A translation preview whose `result.recoveryRequired` is `true` keeps its status, but
`jobs_wait` returns it at once: provider acceptance is uncertain and polling will not
resolve it. Do not create another job for it.

The mapping lives in `src/tools/job-status.ts`. The per-kind `wait: true` waiters use the
same rules to decide when to stop.

## Many jobs at once

`jobs_create-many` starts 2 to 50 independent jobs by running one create tool once per
item, and `jobs_get-many` reads up to 50 jobs of any kind at once. They are for requests
such as "lip-sync this video to these 7 audios", "translate this video into 7 languages"
(one `dubbing_create` item per language) or "one Edit Dialogue variant per name" (one
`dialogue-previews_create` item per name, then one `dialogue-videos_create` item per
approved preview).

They are not the batch API. Every item is an ordinary call to the create tool, so it uses
the same API path, plan limits and billing as calling the tool once per item, on any plan,
and starts as soon as the account has capacity. `batches_create` stays for Scale accounts
with large runs (20 to 500 generations) that can wait hours in the batch queue.

### `jobs_create-many`

Input: `{tool, idempotencyKey, items}`.

- `tool` is one of the create tools this connection lists: `lipsync_create`,
  `lipsync_create-timeline`, `dubbing_create`, `dialogue-videos_create`,
  `dialogue-previews_create`, `speech-previews_create`, `translation-previews_create`, and
  locally `generations_create`. Any other name is refused by the input schema, which lists
  the allowed ones.
- `items` are that tool's own arguments, one object per job. Every item is validated
  against the tool's schema before anything starts, and a repeated item is refused, so a
  typo never leaves half a set started.
- `idempotencyKey` is a fresh UUID for the approved set. An item without its own
  `idempotencyKey` gets one derived from the set key, the tool and the item's other
  arguments; an item without `projectId` gets a derived `projectCreationKey` the same way.
  Calling again with the same set key and the same items therefore resends the same keyed
  requests and the same new projects, which the API replays instead of creating again.

Each item runs through the same server path as a direct call (`callTool` in
`src/server.ts`), so the project-intent guard, the per-call `organizationId`, upload
refusals for clients without uploads, and every error behave exactly as they do for one
call. The tool's description carries the spend-confirmation sentence (estimate each
distinct configuration, tell the user the count and total, wait for one confirmation of the
set); unattended mode removes it like the other paid tools' sentences.

Scheduling:

- It reads the plan's concurrent generation limit (`GET /v2/account`, the
  `generationLimits.concurrency` that `account_get-context` shows) and keeps at most that
  many items in flight, at most 10, or 2 when the limit cannot be read.
- A 429 (`concurrency_limit_reached`) pauses every item for its `Retry-After` (20 seconds
  from the API; at least 1 second), then the same request is sent again with the same key.
  A 409 `IDEMPOTENCY_IN_PROGRESS` or `import_in_progress` waits for that item alone. These
  refusals come before the API admits anything, so resending never duplicates a job.
- A 401 or 402 stops new items from starting, since every other item would be refused the
  same way. Any other error fails only its own item.
- No new attempt starts after 40 seconds, and requests in flight are never abandoned, so
  the call returns within about 50 seconds. It never waits for the jobs themselves.

Output: `{tool, summary, items, jobs, remaining?, nextStep}`. `items` has one
`{index, status, kind?, id?, error?}` per input item, in order, with `status` one of
`started`, `failed` or `not_started`. `jobs` lists the started ones as `{kind, id,
projectId?, videoAssetId?}`, ready to pass to `jobs_get-many`. When some items could not
start because the account stayed at its limit, `remaining` holds `{tool, idempotencyKey,
items}` to send again later, unchanged. Progress notifications report how many items have
started.

### `jobs_get-many`

Input: `{jobs: [{kind, id, projectId?, videoAssetId?, projectIntent?}], wait?}`, up to 50.
It reads each job through the same per-kind reader as `jobs_get`, eight at a time, and
returns `{jobs, counts}`: each job's unified state in input order, or `{kind, id, error}`
for one that could not be read, and counts of `running`, `completed`, `failed` (also
REJECTED and CANCELED) and `unreadable` jobs. With `wait: true` it waits like `jobs_wait`,
up to about 50 seconds, reading again only the jobs still running.

Besides the kinds above it reads `dialogue_preview` (needs `projectId` and `videoAssetId`)
and `speech_preview` (needs `projectId`), so every job `jobs_create-many` starts can be
followed. A speech preview's `SUCCESS` and an Edit Dialogue preview's `COMPLETED_PARTIAL`
count as `COMPLETED`. `jobs_get` and `jobs_wait` keep their published kind list.

A job created in another organization through a one-call `organizationId` is read in that
organization, as `jobs_get` does.

## Why `jobs_get` and `jobs_wait` are not on the hosted server

The hosted tool list is the ChatGPT app's reviewed listing, and Codex shares those
descriptors. Adding tools there needs a Rescan in the OpenAI publisher and may need app
review. Hosted clients can already wait on every hosted job kind with `wait: true` on
`generations_get`, `translation-previews_get` and `assets_create`, and the hosted
server has no transcription or speaker-analysis tools that would produce those ids.
Offering `jobs_get` and `jobs_wait` to hosted Claude, Cursor and Codex clients is a
possible follow-up.

`jobs_create-many` and `jobs_get-many` are hosted, like the batch tools: every hosted client
but the ChatGPT app lists them (`isToolVisible` in `src/server.ts`), so the reviewed ChatGPT
listing is unchanged. On the hosted server `jobs_get-many` reads only the kinds whose read
tool is hosted (no transcriptions).
