# Jobs: `jobs_get` and `jobs_wait`

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

## Why not on the hosted server

The hosted tool list is the ChatGPT app's reviewed listing, and Codex shares those
descriptors. Adding tools there needs a Rescan in the OpenAI publisher and may need app
review. Hosted clients can already wait on every hosted job kind with `wait: true` on
`generations_get`, `translation-previews_get` and `assets_create`, and the hosted
server has no transcription or speaker-analysis tools that would produce those ids.
Offering the jobs tools to hosted Claude, Cursor and Codex clients is a possible follow-up.
