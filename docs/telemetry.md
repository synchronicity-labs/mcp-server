# Usage telemetry

The server records two kinds of event so we can see how people use sync. through
their agents: when a session starts, and every tool call it makes. Events go to the
sync. API with the caller's own credential (`POST /v2/analytics/mcp-events`), and the
API sends them to PostHog. They never contain prompts, scripts, file names, URLs,
media, tokens, API keys or error messages.

The API resolves who sent an event from the credential, the same way it attributes
generations, so API-key users and people who never generate are counted too. The
body carries no user, organization or credential fields, and the API ignores any.

## What each question reads

| Question | Event | Read |
| --- | --- | --- |
| Who connected, per client and auth method | `mcp_session_initialized` | `distinct_id`, `client_profile`, `client_name`, `auth_method` |
| New or returning | `mcp_session_initialized` | the person's first event of this name |
| Who is active | `mcp_tool_called` | distinct `distinct_id` per day or week |
| Which tools, how reliable, how fast | `mcp_tool_called` | `tool_name`, `outcome`, `error_code`, `latency_ms` |
| In what order | `mcp_tool_called` | `conversation_id` or `session_id`, then `call_index`, `previous_tool` |
| What they ask for, without the content | `mcp_tool_called` | `args` facets, read as `properties.args.<field>` |
| Connect to generation result | both, then the API's `generation_completed` and `generation_failed` | `generation_id` |

## Events

The MCP server sends a batch of at most 50 events:

```json
{
  "events": [
    {
      "event": "mcp_tool_called",
      "event_id": "uuid",
      "timestamp": "2026-11-09T12:00:00.000Z",
      "properties": { "session_id": "uuid", "tool_name": "lipsync_create", "args": { "model": "lipsync-2-pro" } }
    }
  ]
}
```

The API adds `organization_id`, `auth_method` (`oauth`, `api_key` or `session`), `mcp_version`
and `mcp_client` from the credential and headers. It sets `distinct_id` the way
`generation_created` does: the user, the API key's owner, or the organization for an
ownerless key. It keeps `args` as one object (read a field as
`properties.args.model`) and uses `event_id` as `$insert_id`, so a resent batch is not
counted twice. PostHog's `timestamp` is when the API received the event, usually
within two seconds of the call, and calls sent in one batch share it; order calls by
`call_index` instead.

### Every event

| Property | Values |
| --- | --- |
| `session_id` | Random per MCP session. Not the `Mcp-Session-Id` header |
| `transport` | `http` (hosted) or `stdio` (npm package) |
| `client_profile` | `chatgpt`, `codex`, `claude` or `generic` |
| `client_name` | The handshake name, lowercased, such as `claude-code` or `cursor`. Self-reported |
| `client_version` | The handshake version when it looks like a version |
| `server_version` | This package's version |
| `server_revision` | The deployed commit, or `unknown` |

### `mcp_session_initialized`

| Property | Values |
| --- | --- |
| `protocol_version` | The version the client asked for, such as `2025-06-18` |
| `client_capabilities` | The capabilities it declared: `sampling`, `elicitation`, `roots`, `tasks`, `ui` |
| `toolsets` | stdio only: the toolsets it listed |
| `spend_confirmation` | `false` when spending was pre-approved |

### `mcp_tool_called`

| Property | Values |
| --- | --- |
| `call_id` | Random per call |
| `tool_name` | The tool's current name |
| `called_as` | The old name, when the client called a renamed tool by it |
| `call_index` | 1 for the first call, then 2, 3…, counted in the conversation or the session (see below) |
| `previous_tool` | The tool called before this one in the same conversation or session |
| `ms_since_previous_call` | Gap since that call, in milliseconds |
| `ms_since_session_start` | Gap since this MCP session started, in milliseconds |
| `parent_call_id` | For calls `jobs_create-many` makes on the agent's behalf |
| `invocation` | `model`, `ui` (a user action in the widget), `background` (the widget on its own) or `nested` |
| `outcome` | See below |
| `error_status`, `error_code` | API status and code, when there is one |
| `invalid_fields` | For `invalid_arguments`: the top-level fields that failed validation |
| `latency_ms` | Time inside the server, including API calls |
| `args` | Facets of the arguments; see below |
| `generation_id`, `job_id`, `batch_id`, `project_id` | IDs the result returned |
| `result_status` | The result's status, such as `PROCESSING` or `COMPLETED` |
| `result_count` | How many items a list returned |
| `conversation_id` | ChatGPT only: SHA-256 of its `openai/session` |
| `locale`, `country` | ChatGPT only: `openai/locale` and `openai/userLocation.country` |

ChatGPT and Codex open a new MCP session for nearly every call, so on the hosted
server a call that carries a `conversation_id` and is not `background` is counted in
its conversation: `call_index`, `previous_tool` and `ms_since_previous_call` continue
across sessions. Other calls are counted in their session. The count lives in the
server's memory, so it starts again at 1 after a deploy and after six quiet hours.

The ChatGPT widget names its calls `ui` or `background`. Where the widget runs without
its analytics, as in Codex, a call to a widget-only tool (`ui.visibility` without
`model`) is `ui` when it carries an `idempotencyKey` and `background` otherwise.

`outcome` is one of:

- `success`: the tool returned a result.
- `invalid_arguments`: the arguments did not match the tool's schema. Nothing ran.
- `refused`: a check in this server stopped the call, such as a missing `projectIntent`, an app-only tool or a local file passed as a URL. Nothing reached the API.
- `api_error`: the API rejected the request or failed. `error_status` and `error_code` say why.
- `timeout`: the API did not answer in time.
- `cancelled`: the client cancelled the call.
- `tool_error`: anything else, usually a bug in this server.

### Argument facets

`args` records the shape of a call, never its content. Each top-level field the tool
declares becomes one entry:

| Field | Recorded |
| --- | --- |
| One of a fixed list (model, mode, workflow) | The value |
| Boolean or number | The value |
| Language code (fields named like `language`) | The code, such as `es` or `pt-BR`; a list of codes is joined, such as `es,fr` |
| `model`, `provider`, `voiceId`, `format`, `contentType`, `status`, `tool`, `errorCode` | The value when it is one token, such as `lipsync-2-pro` or `video/mp4` |
| UUID | `uuid` |
| URL | `url:` and a host class: `youtube`, `tiktok`, `instagram`, `x`, `facebook`, `vimeo`, `google_drive`, `dropbox`, `sync`, `openai_file`, `s3`, `gcs` or `other` |
| Local file path | `path` |
| Other text | `text:` and its length range: `1-20`, `21-100`, `101-500`, `501-2000` or `2001+` |
| List | `array:` and its length |
| Object | `object` |

A recorded value must be one token of at most 64 characters, with no spaces, URL scheme,
`@` or file extension (dots only before a digit, as in a version). Anything else is recorded
by its kind, and the API refuses a batch that breaks this. Fields the tool does not declare
are not recorded. Hosts other than the listed ones
become `other`, so a customer's own domain never appears.

## Repeats

The widget repeats some calls every few seconds, such as `studio-views_register` while
Studio is open, and ChatGPT and Codex reconnect for nearly every call. So the hosted
server records:

- a `background` call once per person, tool, `outcome`, `error_code`, `result_status`
  and target (the generation, job or Studio view it names) in each ten minutes;
- `mcp_session_initialized` once per person, client name and version, protocol version
  and capabilities in each ten minutes.

Count people and connections from these events, not raw requests. A `session_id` on a
call can have no `mcp_session_initialized` of its own. stdio records every session.

## Delivery

Recording an event never waits and never fails a call. Events wait in a queue for
up to two seconds, grouped by the verified owner of the session, then go out as one
request with a three-second limit; nothing retries. A pending batch keeps the token of
the request that recorded it until it is sent. The queue holds at most 2,000 events and
eight requests in flight, and drops new events when full. `mcp_runtime` log lines
report `telemetry.queued`, `sent`, `dropped` and `failed`.

The server sends nothing until the API's published schema lists
`analytics_captureMcpEvents`, so it can deploy before the API does. When the schema
it read at startup does not list it, the server reads the schema again every ten
minutes and starts recording once it does. It keeps nothing from before then. The
`mcp_runtime` telemetry stats report `active: false` while it waits.

## Turning it off

The npm package honours `SYNC_MCP_TELEMETRY=off`, `--no-telemetry` and
`DO_NOT_TRACK=1`. The hosted server always records events.

## Queries

HogQL for PostHog. Rudy runs the same queries.

Sessions and people per client and auth method, per week:

```sql
SELECT toStartOfWeek(timestamp) AS week, properties.client_profile AS profile,
  properties.client_name AS client, properties.auth_method AS auth,
  count() AS sessions, uniq(distinct_id) AS people
FROM events
WHERE event = 'mcp_session_initialized' AND timestamp > now() - INTERVAL 8 WEEK
GROUP BY week, profile, client, auth ORDER BY week DESC, people DESC
```

New and returning people per day, by their first session:

```sql
WITH firsts AS (
  SELECT distinct_id, min(timestamp) AS first_seen FROM events
  WHERE event = 'mcp_session_initialized' GROUP BY distinct_id
)
SELECT toDate(e.timestamp) AS day, e.properties.client_profile AS profile,
  uniqIf(e.distinct_id, toDate(f.first_seen) = toDate(e.timestamp)) AS new_people,
  uniqIf(e.distinct_id, toDate(f.first_seen) < toDate(e.timestamp)) AS returning_people
FROM events e JOIN firsts f ON e.distinct_id = f.distinct_id
WHERE e.event = 'mcp_session_initialized' AND e.timestamp > now() - INTERVAL 30 DAY
GROUP BY day, profile ORDER BY day DESC
```

Tool reliability and latency, last seven days:

```sql
SELECT properties.tool_name AS tool, count() AS calls, uniq(distinct_id) AS people,
  round(countIf(properties.outcome = 'success') / count(), 3) AS success_rate,
  countIf(properties.outcome = 'invalid_arguments') AS invalid,
  countIf(properties.outcome = 'refused') AS refused,
  countIf(properties.outcome = 'api_error') AS api_errors,
  countIf(properties.outcome = 'timeout') AS timeouts,
  quantile(0.5)(toFloat(properties.latency_ms)) AS p50_ms,
  quantile(0.95)(toFloat(properties.latency_ms)) AS p95_ms
FROM events
WHERE event = 'mcp_tool_called' AND timestamp > now() - INTERVAL 7 DAY
GROUP BY tool ORDER BY calls DESC
```

Most common first three tools of a conversation, or of a session for clients without
conversations:

```sql
SELECT path, count() AS conversations FROM (
  SELECT coalesce(toString(properties.conversation_id), toString(properties.session_id)) AS chain,
    arrayStringConcat(arraySlice(arrayMap(x -> x.2,
      arraySort(x -> x.1, groupArray((toInt(properties.call_index), toString(properties.tool_name))))), 1, 3), ' > ') AS path
  FROM events
  WHERE event = 'mcp_tool_called' AND timestamp > now() - INTERVAL 7 DAY
    AND properties.invocation NOT IN ('nested', 'background')
  GROUP BY chain
)
GROUP BY path ORDER BY conversations DESC LIMIT 30
```

Which tool follows which:

```sql
SELECT properties.previous_tool AS from_tool, properties.tool_name AS to_tool, count() AS n
FROM events
WHERE event = 'mcp_tool_called' AND timestamp > now() - INTERVAL 7 DAY
  AND properties.previous_tool IS NOT NULL AND properties.invocation != 'background'
GROUP BY from_tool, to_tool ORDER BY n DESC LIMIT 50
```

Funnel per client, last 30 days: connected, called a tool, started a generation, and
its result from the API's own `generation_completed` and `generation_failed`:

```sql
WITH people AS (
  SELECT distinct_id, argMin(properties.client_profile, timestamp) AS profile FROM events
  WHERE event = 'mcp_session_initialized' AND timestamp > now() - INTERVAL 30 DAY
  GROUP BY distinct_id
),
called AS (
  SELECT DISTINCT distinct_id FROM events
  WHERE event = 'mcp_tool_called' AND timestamp > now() - INTERVAL 30 DAY
),
started AS (
  SELECT distinct_id, toString(properties.generation_id) AS generation_id FROM events
  WHERE event = 'mcp_tool_called' AND properties.outcome = 'success'
    AND properties.generation_id IS NOT NULL AND timestamp > now() - INTERVAL 30 DAY
),
finished AS (
  SELECT toString(properties.generation_id) AS generation_id, event FROM events
  WHERE event IN ('generation_completed', 'generation_failed') AND timestamp > now() - INTERVAL 30 DAY
)
SELECT p.profile AS profile, uniq(p.distinct_id) AS connected,
  uniqIf(c.distinct_id, c.distinct_id != '') AS called_a_tool,
  uniqIf(s.distinct_id, s.distinct_id != '') AS started_generation,
  uniqIf(s.distinct_id, f.event = 'generation_completed') AS got_a_result,
  uniqIf(s.distinct_id, f.event = 'generation_failed') AS had_a_failure
FROM people p
LEFT JOIN called c ON c.distinct_id = p.distinct_id
LEFT JOIN started s ON s.distinct_id = p.distinct_id
LEFT JOIN finished f ON f.generation_id = s.generation_id
GROUP BY profile ORDER BY connected DESC
```

What people ask `lipsync_create` for. ChatGPT passes attached files as `video`, `audio`
and `image`:

```sql
SELECT properties.args.model AS model,
  coalesce(properties.args.videoUrl, properties.args.videoAssetId, if(properties.args.video IS NOT NULL, 'file', NULL),
    properties.args.imageUrl, properties.args.imageAssetId, if(properties.args.image IS NOT NULL, 'image_file', NULL)) AS visual,
  coalesce(properties.args.audioUrl, properties.args.audioAssetId, if(properties.args.audio IS NOT NULL, 'file', NULL),
    if(properties.args.script IS NOT NULL, 'script', NULL)) AS voice,
  properties.args.script AS script_length, count() AS calls
FROM events
WHERE event = 'mcp_tool_called' AND properties.tool_name = 'lipsync_create'
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY model, visual, voice, script_length ORDER BY calls DESC LIMIT 40
```

Fields agents get wrong:

```sql
SELECT properties.tool_name AS tool, arrayJoin(JSONExtractArrayRaw(toString(properties.invalid_fields))) AS field,
  properties.client_name AS client, count() AS n
FROM events
WHERE event = 'mcp_tool_called' AND properties.outcome = 'invalid_arguments'
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY tool, field, client ORDER BY n DESC LIMIT 40
```
