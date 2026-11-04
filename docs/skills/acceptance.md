# Skill acceptance

This checklist covers the entire sixteen-skill release. Automated metadata and
registration checks do not certify that an agent completed a live workflow.
Record results against the reviewed PR head and the server/client actually used.

## Automated evidence

The implementation's local verification uses the approved generated API fixture
and its pinned hash/provenance in [coverage.json](coverage.json). No provider,
customer media or paid calls are involved in the catalog capture.

- All sixteen canonical and fourteen generated plugin skills pass skill-creator
  metadata validation. Canonical validation also checks self-contained resources,
  documented tool ownership and generated package freshness.
- The wire gate observes 84 distinct tools and 53 parser-selected operations.
  It captures HTTP and stdio handshakes for ChatGPT (`openai-mcp`), the Codex app
  (`openai-mcp (Codex)`), Claude.ai and Claude Code; HTTP additionally exercises
  generic and unknown clients. Widget-only visibility and excluded operations
  remain distinct from model-callable tools.
- The before/after comparison against MCP commit
  `c10a02c387e2544e0d062c1863b77c25af91ed60` preserves all hosted descriptors,
  discovery documents and challenge behavior. Stdio adds optional idempotencyKey
  inputs to raw generation, raw dialogue-edit and raw TTS tools. Two new stdio
  capture profiles are additive to the comparison.
- Coverage regression tests mutate the valid real capture and assert rejection
  for missing HTTP/stdio profiles, a tool absent from only one client, unknown
  tools/owners/classifications, app/stdio leaks, widget visibility drift, forbidden
  ChatGPT tools, missing wrappers and changed parser selections/exclusions. These
  run in the skills CI job after a fresh capture; no copied descriptor baseline
  or production-only test hook is used.
- Admission tests send actual HTTP requests to a local listener, verify identical
  keys reach headers and stay out of JSON, and reject invalid/missing required
  keys before I/O. The three tests fail against the original generator and pass
  with the fix. This proves forwarding, not provider deduplication.
- Package tests verify independent resource copies, stable published names,
  idempotent generation, read-only check mode and rejection of missing/escaping
  resources. Existing plugin tests check manifest/onboarding/tool compatibility.
- Deployment tests use real Git histories: skills-only range, earlier undeployed
  runtime changes, renames across boundaries, missing/divergent history, current
  revision and unknown paths. A skipped deployment passes the existing smoke
  contract using the revision actually served without requiring a new process.

Run commands from [the maintainer guide](../skills.md#maintain-the-catalog).
Full test/check counts and exact revision belong in the PR/CI evidence; rerun
when the reviewed head changes.

## Live release status

**Live paid and embedded-client acceptance remains pending.** A read-only account
context check succeeded against the connected personal Free workspace. Its
15-second limit and single concurrent job do not establish entitlement for every
workflow. No paid generation, synthesis, translation, cloning, destructive cleanup
or feedback submission was performed as part of that check.

Before live acceptance, select an authorized test workspace, a spending ceiling
and permitted synthetic/test media. Follow each tool's quote/consent contract.
Use disposable test resources for deletion and record permission to clone any
speaker. Do not test recovery by intentionally buying duplicate jobs.

The complete catalog is implemented; pending live checks apply to release
certification, not to whether a skill should be included in the first release.
Do not mark this checklist complete based on metadata or a submitted job.

## Per-workflow scenarios

All rows below require live evidence before release certification. An unsupported
client path passes only when the agent gives the correct unavailable response
and a supported route; it must not pretend to have performed the operation.

| Skill | Successful path | Negative or recovery path |
| --- | --- | --- |
| Setup | Install in a clean skill directory; discover the skill; connect through OAuth and stdio; verify organization and actual tools | Expired login uses reconnect; absent upload/app bridge produces the supported alternative without a fake upload |
| Lip Sync | Short video plus saved audio, and video plus script/selected voice; quote, approved submission, terminal result and exact output | Resolve mismatch and ambiguous face; reconcile uncertain submission with the original identity, without a duplicate paid job |
| Talking Photo | Permitted portrait plus audio and script to a completed talking video | Unsupported image/model/voice is corrected before a changed request; source creation is a separate requested action |
| Edit Dialogue | Correct a selected occurrence and remove filler; retain word IDs; review audio; estimate and approve final video | Repeated word resolution; changed preview needs matching approval; partial failure is disclosed and not claimed as complete |
| Translate and Dub | Complete dubbed video; independently quote/review translated audio then render that audio through lip sync | Limited preview requires explicit shortened-source agreement; excluded charges disclosed; saving failure does not repeat translation |
| Timeline | Multiple timed clips, correct speaker/face mapping, supported kept ranges and output audio | Overlap/clip/account limits rejected before a changed request; ChatGPT responds unavailable |
| Speech | Approved script/voice to playable audio, retained job and saved reusable asset | Interrupted synthesis resumes its job; failed attachment does not trigger resynthesis |
| Voices | List/select/inspect, explicitly permitted clone, and confirmed deletion of a disposable saved voice | Clone timeout reconciles by listing; no automatic creation retry or account switch |
| Media | Upload file, register direct URL, complete social import; filter/count/inspect/download; requested rename/visibility/delete; prefix trim | Pending import reuses its identity/backoff; terminal import stops; upload URL/import ID never substitutes for an asset ID |
| Projects | Create/search/read/history/rename; stdio attach/detach/properties/delete on disposable resources | Ambiguous or unauthorized project is resolved; detaching is not treated as deleting media |
| Generations | History/status/result/continuation; stdio count/filename/delete/download | Pending job remains pending; expired result link is refreshed without regeneration; deletion is not cancellation |
| Account | Verify identity/organization, allowance/limits, eligible models, forecast and recorded breakdown | Null/partial usage is not zero; synthesis exclusions and estimate versus actual spending remain explicit |
| Studio | Real open, draft selection, result display and original/output continuation in the embedded UI | Stale revision reconciles; pending/blocked/failed receipt is reported honestly; only widget acknowledgement confirms display |
| Transcription | Saved video and stdio audio/windowed timed words with retained source/job IDs | Source-copy recovery uses canonical ID; limits/units checked without silent prefix truncation; same job polled |
| Advanced Generation | Eligible raw multi-speaker/model-specific request, supported output/callback fields and terminal output | Reject incompatible combinations; confirm admission header on HTTP boundary; no assumed native Batch or webhook-secret retrieval |
| Troubleshooting | Recover representative auth/billing/concurrency/provider failures and one explicitly authorized redacted feedback submission where supported | Feedback absent from ChatGPT or undeployed API yields unavailable; no unsolicited submission or repeated paid retries |

## Client matrix

Run common hosted creative paths in clean Claude Code and Codex CLI connections.
Run app behavior in actual ChatGPT and Codex app sessions with the widget mounted.
Run every stdio-only family through the local server with an authorized key or
user session. Record the installed npm/server version: npm may lag hosted main.
A generic CLI handshake does not establish Codex app support.

| Surface | Required evidence |
| --- | --- |
| Portable skill install | Clean personal or project scope, selection/discovery, one-skill resource closure, reviewed source revision, update and removal |
| Hosted model-only clients | OAuth/account identity, creative completion and same-job recovery, absent widget tools |
| ChatGPT app | Generated fourteen-skill package, original five names and setup policy, actual Studio UI, no timeline/feedback exposure |
| Codex app | Actual app context and applied UI, available timeline path; no assumptions based on the Codex CLI |
| Local stdio | Actual advertised schema, raw TTS/transcription, expanded management, advanced generation, real header forwarding |

## Evidence record

For each scenario retain: skill source revision, MCP served revision or npm
version, API fixture/live version, client version/handshake, transport/profile,
non-sensitive input fixture identity, intended action, quote and authorized
spending ceiling, job/resource IDs, terminal or pending status, actual cost when
available, observed output/UI result, and any unsupported capability or blocker.

Keep private media, credentials, voice samples, request keys and signed URLs out
of committed evidence. Retain private artifacts in the authorized test workspace
and link only evidence safe for reviewers. A private local artifact is not a
public proof link. Record a gap when access or budget is unavailable.

Merge, hosted deployment, npm release and ChatGPT publisher upload are separate
steps. After approved merge, verify the bootstrap deployment's exact revision.
Only after explicit publisher authorization upload the versioned package, then
verify the approved package and any MCP rescan in new client sessions.
