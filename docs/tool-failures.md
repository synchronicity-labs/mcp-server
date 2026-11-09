# Why tool calls fail

There are two places to look:

1. **Failures inside the MCP server.** Its own checks reject the call before anything reaches the API, for example a missing `projectIntent` or a file passed where a URL belongs. The hosted server writes one stdout line per failed call with `event: "mcp_tool_error"`, `tool`, `profile`, `source` (`mcp` or `api`) and `message`. When the API answered, the line also has its `status` and `code` and no `message`: the API's own text can quote what the user sent, and BetterStack keeps it (below). For this server's checks, `message` keeps the wording with quoted values, links, ids, paths, emails and long numbers replaced, and validation errors list the failing fields. Read these lines in the Porter logs for `mcp-server`.
2. **Failures in the API.** The API rejects the request, for example over a plan limit, a concurrency limit or invalid input. Every API response is logged in BetterStack source `[Prod] Sync API V2` (region eu) as an `api_response` line. Responses of 400 and above carry `errorCode` and `errorMessage`.

PostHog event `mcp_tool_called` counts every call per tool and client with its `outcome`, `error_status` and `error_code` (see `docs/telemetry.md`); `chatgpt_tool_called` covers the ChatGPT app's own tools. Use them to measure failure rates and the two sources above to find out why.

## API failures from hosted MCP clients

Hosted MCP requests have user agent `node`, a `userId` and no `apiKeyId`. This query groups the last five days of write failures by reason:

```sql
SELECT JSONExtractString(raw,'routeTemplate') route, JSONExtractInt(raw,'statusCode') sc,
  JSONExtractString(raw,'errorCode') code, substring(JSONExtractString(raw,'errorMessage'),1,170) msg,
  count() n, uniqExact(JSONExtractString(raw,'userId')) users
FROM s3Cluster(primary, t202575_prod_sync_api_v2_s3)
WHERE _row_type = 1 AND dt > now() - INTERVAL 5 DAY
  AND JSONExtractString(raw,'message') = 'api_response' AND JSONExtractString(raw,'userAgent') = 'node'
  AND JSONExtractString(raw,'apiKeyId') = '' AND JSONExtractString(raw,'userId') != ''
  AND JSONExtractString(raw,'method') IN ('POST','PUT','PATCH','DELETE')
  AND JSONExtractInt(raw,'statusCode') >= 400
GROUP BY route, sc, code, msg ORDER BY n DESC LIMIT 60 FORMAT JSON
```

- `s3Cluster` lags about 45 minutes. For the most recent requests, query `remote(t202575_prod_sync_api_v2_logs)` as well.
- To tie one ChatGPT call to its API requests, match the PostHog event's `actor_user_id` and time against `userId` and `dt` here. A call that made no API write in its window was rejected inside the MCP server.

## What the November 2026 audit found

Five days of `lipsync_create` calls from ChatGPT, October 29 to November 3, failed 30–60% of the time. The causes, largest first:

- **Resubmitting while a generation still rendered.** Agents called `lipsync_create` again every few seconds and uploaded the same file each time. Free plans run one generation at a time, so every resubmission failed with `concurrency_limit_reached`. `lipsync_create` now returns the running generation for an identical request.
- **Free-plan limits.** Outputs are limited to 15 seconds and speech to 20 seconds, and the plan includes 3 generations a month. Error results now tell the agent to shorten the input instead of retrying.
- **Uploads.** ChatGPT file links sometimes report `application/octet-stream`, and the API rejects that type. The upload now uses the first media type of the expected kind.
- **Options the API rejects.** Agents turned on `reasoning_enabled` for sync-3 and speaker detection for a still image. Both are now dropped.
- **Dialogue edits.** The OpenAPI conversion lost the item schema, so agents guessed the shape of each edit. The tool now declares it.
