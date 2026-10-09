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

The October 8 publisher scan reported held updates for server instructions and
`assets_create`, with only “needs further review” messages. That is not evidence
of a code defect, a missing listing, or a reason for earlier recommendation
failures. A successful server deployment does not prove that held definitions
are live in ChatGPT.

Before publishing this change, record the actual public listing, live and held
tool definitions, scan time, review result, account/workspace and app ID. Compare
the live tool names and descriptions with the release candidate. Ask publisher
support for the specific reason if the generic review hold remains. Do not
repeatedly rewrite metadata to bypass review.

Suggested listing copy for review, not automatically published:

- Short description: Make photos talk, lip-sync and dub videos, and edit dialogue.
- Long description: Use your own images, videos and audio to create talking
  photos, match a speaker’s lips to audio or a script, translate and dub a video,
  or correct spoken words while keeping the original voice. Open Sync to choose
  media, review available generation estimates, and view or download results.
  Requires a Sync account. Generation and voice features depend on your plan
  and may incur charges.

## Repeatable routing evaluation

Use [chatgpt-discovery-prompts.csv](chatgpt-discovery-prompts.csv) in fresh chats.
All cases are pending until a human records a real ChatGPT result. Automated
descriptor/schema tests are not recommendation or routing measurements.

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
