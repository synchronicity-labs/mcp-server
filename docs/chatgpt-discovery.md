# ChatGPT discovery and publication checks

Owner: CRAFT-6310. Endpoint: `https://mcp.sync.so/mcp`.
Production app: `asdk_app_6a398355fbc08191a232e7eeeacb73d5`.

Tool metadata helps ChatGPT select an available tool. It does not guarantee app
recommendations or directory placement. Test those separately.

## Publication baseline

Read-only public-directory check, October 8, 2026 (EDT): searching `sync` on
ChatGPT's Plugins page returned `sync. labs` in Public results. The detail page
for the production app above showed version `1.0.0`, short description “Dub and
lip-sync videos”, and long description “Use sync. labs to dub videos, replace
dialogue, generate lip-synced performances, and animate images.” This verifies
listing presence for that account, not proactive recommendations or the current
approval state of individual tools.

The same public detail page's app tool catalog includes dialogue transcription,
read and estimate tools, but omits `create-dialogue-preview` and
`create-dialogue-video`. The connected tool inventory in the audit chat also
omits these two names. This is an observed publication/availability gap, not a
diagnosed cause: inspect those definitions in the publisher view before claiming
full public Dialogue acceptance. `voices_clone-voice` is also absent, as expected
before the separate hosted-cloning change.

The October 8 publisher scan reported held updates for server instructions and
`assets_create`, with only “needs further review” messages. That is not evidence
of a code defect, a missing listing, or a reason for earlier recommendation
failures. A successful server deployment does not prove that held definitions
are live in ChatGPT.

October 11 follow-up: the directory still returns Sync for `sync`, with version
`1.0.0` published. The publisher lists `2.0.0` as ready to publish, but its
contents must be compared before release. The MCP connection is authorized;
`assets_create` is now live. Server instructions still show “Earlier version
live”, and `create-dialogue-preview` and `create-dialogue-video` show “Not live”
with the generic server-instructions review finding. This blocks complete
public Edit Dialogue acceptance. It does not establish why a recommendation
was absent. The published listing shows Entertainment, no capabilities, and no
skills; absence of optional skills is not itself a publishing defect.

October 12 follow-up: server instructions are now Live. The two Dialogue write
tools remain Not live; the other 24 tools are Live. The publisher connection is
authorized. Optional package 2.0.1 is an unsubmitted draft, not the published
version. Support has been asked for actionable held-tool review requirements
and confirmation of in-chat discovery eligibility/indexing.

### Dialogue tool review follow-up

The October 28 report names `create-dialogue-preview` and `create-dialogue-video`
with “This new tool definition needs further review before it can be published.”
This generic finding does not identify a failed runtime call or its review cause.

Both descriptors now set `openWorldHint: false`: they accept saved source and job
IDs accessible to the connected Sync account, with no arbitrary source URL,
destination or voice input. External hosting and provider processing alone do
not make that a tool with open-ended entities. Both remain non-read-only and
destructive because they queue synthesis/generation work that can incur charges;
neither promises unconditional idempotency. The preview descriptor discloses
source-voice cloning, synthesis charges, required approval, asynchronous polling,
partial failures and conditional keyed recovery. `upload-dialogue-source` keeps
`openWorldHint: true` because it can fetch a saved external source URL.

After the reviewed change is merged and deployed:

1. Scan Tools on the existing production publisher connection. Inspect both
   exact tool names and verify the updated descriptions, schemas and annotations.
2. Submit the held definitions for review. If the same generic finding persists,
   use the publisher support/appeal flow with the app ID above, the deployed SHA,
   scan timestamp and exact findings; request an actionable reason. Do not rename
   tools, weaken write/destructive hints or add an executor to bypass the hold.
3. After approval, publish the approved update and refresh the installed
   connection. Verify both names in the published catalog and a fresh chat.
4. With an authorized demo account and source, exercise transcription, an
   explicitly approved preview, preview polling, final cost estimate, an
   explicitly approved final generation and result polling. Verify access denial
   and retry recovery separately. Record actual published availability and
   provider-backed results; fixture tests are not evidence of either.

Reference: [OpenAI MCP server review requirements](https://developers.openai.com/plugins/deploy/app-review)
and [tool annotation guidelines](https://developers.openai.com/plugins/plugin-guidelines#correct-annotation).

### October 12 baseline results

Completed 135 trials: all 15 prompts repeated three times in each of the three
contexts below. Environment: one supplied Personal Plus account in Chrome
Incognito, Chat mode, Instant. Exact model ID and geographic eligibility were
not exposed. Conversations were fresh, but account memory/history was not reset;
these are not independent random samples. No media was attached and no paid
generation was started. This measures discovery and clarification, not output
quality or the effect of this unreleased PR.

- Not connected, 45 trials: Sync was mentioned in 4 of the 24 unbranded supported
  workflow trials, including 3 indirect lip-sync prompts and 1 indirect dialogue
  prompt. The 9 direct photo/lip-sync/dubbing trials had no Sync mention. No Sync
  install card was observed. The two interactive brand mentions inspected opened
  company information panels; the second was inspected after connecting the
  account, without regenerating the original response. A separate explicit
  category control produced a HeyGen install card; directory search finds Sync.
- Connected but unselected, 45 trials: all 3 explicit Open Sync prompts rendered
  the real app. History was returned in all 3 read-only trials. Whole-script
  replacement was overpromised in all 3 boundary trials.
- Explicitly selected, 45 trials: all 3 Open Sync prompts rendered the real app;
  the 6 photo prompts rendered its image/audio uploader. History was returned in
  all 3 trials. Two French-dubbing trials reported connection/media-retrieval
  failures; later account reads recovered. The public health endpoint returned
  HTTP 200, which does not establish authenticated connection health.
- Capability boundaries remain inaccurate: the selected subtitle-only trials
  opened Sync and implied support in 3/3; general editing was overpromised in
  2/3, with the third explaining the limitation. Whole-script replacement was
  not clearly rejected in 3/3 selected trials (one qualified that replacements
  would first be assessed). Audio-only trials explained the lack of standalone
  MP3 generation. No paid operation was observed.

This PR now explicitly states these limits in the server instructions and app
opener description. Passing descriptor/integration tests does not prove improved
model behavior. Repeat the matrix against a private candidate before release;
do not describe this baseline as an A/B result. Investigate the intermittent
authenticated failures separately, without inferring their cause from the UI.
Local raw trial records and screenshots are retained in the task's October 12
discovery evidence directory; private account media details are not committed.

Before publishing this change, record the actual public listing, live and held
tool definitions, scan time, review result, account/workspace and app ID. Compare
the live tool names and descriptions with the release candidate. Ask publisher
support for the specific reason if the generic review hold remains. Do not
repeatedly rewrite metadata to bypass review.

Suggested listing copy for review, not automatically published:

- Short description: Dub and lip-sync videos
- Long description: Use your own images, videos and audio to create talking
  photos, match a speaker’s lips to audio or a script, translate and dub a video,
  or correct spoken words while keeping the original voice. Open Sync to choose
  media, review available generation estimates, and view or download results.
  Requires a Sync account. Generation and voice features depend on your plan
  and may incur charges.

Keep the existing short description: it is accurate and within the documented
30-character limit. The longer proposed description requires publisher review;
do not replace already accurate metadata just to make it different.

## Repeatable routing evaluation

Use [chatgpt-discovery-prompts.csv](chatgpt-discovery-prompts.csv) in fresh chats.
The October 12 published-version baseline is recorded above; the candidate
comparison remains pending. Automated descriptor/schema tests are not
recommendation or routing measurements.

Run the same prompts before and after the metadata update in three separate
contexts, keeping account, model, workspace, region and plan constant:

1. Sync not connected: record recommendation/connection prompt, if any. Absence
   is a discovery observation, not a failed tool call.
2. Sync connected but not selected: record whether Sync is offered/selected and
   which workflow is identified.
3. Sync explicitly selected: record workflow choice, requested missing inputs,
   estimates and confirmation. Stop before any paid action.

For each run record date, app ID, server revision, live tool definition/scan
version, model, connection context, prompt ID, response, selected tools and
pass/fail rationale. No sample, language, voice, or user confirmation may be
invented to satisfy a prompt. A correct clarification is a pass when required
inputs are missing. Do not use real user data for these tests.

Report each context separately: positive routing recall, negative false-positive
rate, and unsupported paid actions (must be zero). Use at least three fresh runs
per prompt/context for the baseline and candidate. Report sample sizes and raw
outcomes; change one metadata surface at a time when attributing improvements.

## Measurement boundaries

| Stage | Evidence needed | Current interpretation |
| --- | --- | --- |
| Recommendation impression | Host-provided impression data | Not observable from MCP requests alone |
| Connection completed | Successful OAuth completion, deduplicated user/organization | Not a website referral or a generation |
| First tool use | Authenticated tool invocation, tool name, client/source, result and timestamp | Must separate read-only discovery from writes |
| First successful video | Completed generation with original MCP source | Count distinct connected users, not only creators, for activation |
| Paid conversion | First paid event joined to the connected cohort | Specify time window and denominator |

`metadata.source = mcp:openai-mcp` on a generation identifies that generation's
source. It does not establish installation, recommendation attribution, or the
number of all connected accounts. Track the funnel in a separate analytics
change with deduplication and retention rules; do not send prompts, media URLs,
transcripts or tokens into discovery telemetry.

References:
- https://developers.openai.com/plugins/guides/optimize-metadata
- https://developers.openai.com/plugins/plugin-guidelines
