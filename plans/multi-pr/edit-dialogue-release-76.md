# Edit Dialogue release preparation

## Release hold

Noah approved the full 34-commit dev batch through a558d7d5e6b4f58d7dabdf19a64ab903e20cfa55.
He owns pilot-flow acceptance and must confirm before production promotion or MCP
deployment. Keep monorepo release #6505 draft and MCP #76 unmerged. Recheck scope
if dev changes. No new paid preview or generation is authorized.

## Evidence

- Frontend/shared editor #6474 merged into dev; implementation passed full CI,
  Greptile 5/5 and Claude Ready to merge.
- Release #6505 CI checkout 0140adbb3d83111790cbb11bf8a31fbe108f0a42 has the same
  tree e5740e67ac22311309af110ecd4001382d307f10 as dev a558d7d5e6. Its 228 browser
  cases passed against development and artifact. Packaged bytes and provenance
  are in deploy/chatgpt/0f4f454753a88e6264cf1393500c9d9dac8673040459642407230a0e1ddbb258/.
- MCP tools at 036b4bffd passed 517 tests, CI and Greptile 5/5. Packaging changes
  require fresh CI and review; previous approval is not approval of new bytes.
- Approved real local-bridge test completed transcription, original-voice preview,
  final $0.35 estimate, video generation, reload recovery, playback and download.
  This used the production API with the local candidate, not published ChatGPT.
- Dev run 37778631254 deployed the a558 backend successfully. Live API and worker
  each have 1/1 ready replicas on image digest f900d78d34a42cf5940d122e69a91ace622341f60b0fd5a9aac9660c88210db8.
  Frontend completion then failed its backend-identity gate. Do not call the
  coordinated dev release complete until the mismatch is understood and repaired.

## Remaining gates and order

1. Verify coordinated dev deployment and current frontend/backend identity.
2. Noah tests pilot activation, allowances, expiry, extensions and explicit paid
   conversion, including retries and expected billing. Automated evidence does
   not replace his acceptance.
3. Current-head full-batch and MCP package CI/reviews pass; resolve findings.
4. After Noah's confirmation, normal monorepo production promotion, migration
   and runtime verification. Batch includes additive support billing-reset and
   dialogue-idempotency migrations; the unique index uses a concurrent migration.
5. Then normal MCP merge/deployment, verify intended image and ready replicas,
   active resource hash and all three retained resource reads.
6. Rescan publisher metadata if needed; verify a fresh ChatGPT session visually,
   including editor, preview/cost/results/recovery. Seek a separate approved
   budget for any additional paid operations. Keep broader parity/acceptance
   work open; do not mark CRAFT-6496 Done from packaging checks alone.

## Keyed embedded preview recovery checkpoint

The adapter now advertises keyedPreview only when the upstream dialogue-create
operation declares Idempotency-Key. A keyed request on an older API is refused
before synthesis. Supported calls forward the exact key through the authenticated
HTTP client without automatic retries. The source URL comes from the immutable
transcription/preview snapshot after project, asset and source verification, so
rotating asset playback signatures do not change recovery bodies. Initial
previews forward the transcription job identity.

Boundary regressions fail on missing headers and unsafe unsupported admission,
then pass after the repair. All 579 tests in 43 files, typecheck and lint pass
(three existing informational template-literal notices). Logs are
/tmp/pr88-dialogue-key-boundary-baseline.log, /tmp/pr88-dialogue-key-fixed.log,
/tmp/pr88-dialogue-full-tests.log, /tmp/pr88-dialogue-key-types.log and
/tmp/pr88-dialogue-full-lint.log. Read-only preservation review is clean.

Widget adoption, frozen persisted preview intent, restored transcription
identity, safe voice reuse and speaker adapters remain open in coordinated
PR #6822 work. This checkpoint does not package the frontend or establish
release readiness or deployed acceptance.
