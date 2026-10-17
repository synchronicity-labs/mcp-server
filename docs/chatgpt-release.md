# ChatGPT frontend release

The MCP production image includes the approved, self-contained frontend from
Sync's monorepo. It does not build Studio or fetch another repository at deploy
time. The checked-in release manifest selects the active UI with each deployment.
Existing production origins and OAuth settings are kept.

## Included release candidate

- Source: [PR #6822, commit a914ce699](https://github.com/synchronicity-labs/sync-api-v2/commit/a914ce6999d32158403d3df27772692fa16b4b88).
- HTML SHA256: `2f6bcdc402f636f6c7edf89af45beab18476b7707aecd0277d25a8c05c4754e5`; HTML size: 6,208,480 bytes.
  The clean committed-source rebuild matches the browser-tested bytes.
- Conventional shared `className` forwarding fixes the required full-CI lint
  failure without changing class values or native defaults. All 8 affected
  source/artifact browser cases, full repository lint/formatting, boundaries
  and 28 type/build tasks pass; independent preservation review is clear.
- Current and canonical-history results render one in-flow shared download row
  at every host width. This repairs desktop controls clipped by the embedded
  scroll boundary and removes duplicate download state. Shared/native Studio
  defaults, access checks, host acknowledgement and refusal fallback are kept.
- Parent download batch passes 20 source/artifact cases: bounded processing/completion,
  desktop current/history download containment, compact playback, failed-result
  recovery, host-download refusal fallback and translated-audio handoff.
  Changed-file lint and all 14 affected type/build tasks pass. Independent
  preservation/Ponytail review is clear. The existing video-size guard is kept.
- The previous light-token correction was verified in the actual private plugin:
  light card text has at least 4.54:1 contrast; actual native dark endpoints stay
  unchanged. Compact media layout and processing continuity remain preserved.
- Parent `50a4828ea` integrates dev `d892e1027`, preserving dialogue quality
  disclosure. Its 449 native, 91 real-DB HTTP, 145 worker, 4 browser and 9 MCP cases
  pass. Parent Greptile 5/5 and Claude Ready to merge are historical evidence;
  the new checkpoint still requires fresh current-head reviews and CI.
- Exact parent UI `a7f08c98` passed real private-plugin acceptance: automatic
  OAuth refresh HTTP200, one explicit free lipsync-2 generation completed via
  the real controller/local completion bridge, playback and canonical-history
  recovery after full reload. Native Studio shows the same job. The new job
  has zero credit-ledger entries and zero credit deduction. This does not prove
  the original Chrome browser's separate saved key was retried.
- Packaging replaces only unmerged `dc6de039`, retaining all eight previously
  packaged releases and their 24 files unchanged. Private candidate files are
  preserved separately for rollback. The same connected private plugin will be
  refreshed; no new account connection or production configuration is needed.

The parent exact download candidate passed live private current/history playback,
compact/desktop containment and OAuth refresh HTTP 200. Its normal external link opens
the real video with the native Download option. A separate automation download
probe timed out, so saved-file acknowledgement is not claimed.

Exact-candidate private-plugin checks, fresh required CI/reviews, eligible MCP
approval, original Chrome same-key retry and remaining parity still gate full
readiness. Complete result continuation has not started because current
acceptance comes first. Full multi-draft behavior and output forwarding remain
incomplete. The local pinned React audit was interrupted under memory pressure;
required cloud CI remains authoritative. Do not merge, publish or deploy.
See the source PR's `plans/pr-6822-studio-parity.md` for the checklist.

## Initial project data

`open-sync-app` reads the canonical first project page using the same generated
`projects_get-all` handler and request authentication as normal browsing. It
returns the page only in result `_meta["sync/initialProjects"]`, with version 1
and `fetchedAt` in epoch milliseconds. Shared resource HTML and model-visible
content contain no account data. The optional request is canceled after 500ms;
a failure still opens the widget, which falls back to its normal project read.
The read only runs when the active bundle manifest declares
`initialProjectsVersion: 1`. Older bundles open immediately without prefetching.
The candidate frontend validates
freshness and shape before seeding its first-page cache. This removes a host
round trip; it does not change ChatGPT's time to dispatch the opening tool.

`deploy/chatgpt/<HTML SHA256>/` contains deterministic gzip-compressed HTML,
the frontend's original manifest, and source/build provenance in `release.json`.
Compression keeps the generated artifact small; the manifest hashes the
uncompressed HTML. The manifest verifies the exact uncompressed bytes recorded in each release.

`npm run build && npm run package:chatgpt` expands and validates every included
release in `chatgpt-dist/`. Docker copies only that verified output to its final
image. No registry credentials, local environment files, or preview settings are
part of the frontend package. The Docker context excludes local environment
files, dependencies, and generated build outputs.

CI reads each packaged resource using an actual MCP client/server handshake in
the final production image with networking disabled. This proves artifact
delivery and protocol wiring, not production OAuth, storage, or generation.

## Normal production release

1. Include the approved frontend bytes and update `deploy/chatgpt/releases.json`:
   `current` selects the active HTML hash; `previous` retains up to eight older hashes.
2. Merge the reviewed PR. The existing main/Porter workflow deploys the image,
   and the image's `SYNC_CHATGPT_APP_RELEASES` points to the packaged manifest.
   No per-release Porter edit is needed. This release automatically activates the
   frontend selected by the checked-in release manifest.
3. Verify ready replicas, the opening tool's resource URI, and reads of both the
   active and retained resources. Refresh the plugin metadata in the publisher
   portal when needed; automatic server activation does not bypass OpenAI's
   metadata review or refresh process.
4. In a fresh ChatGPT conversation, verify opening/projects, model selection,
   upload/recording, generation playback, and history. Live generation uses the
   reviewer's approved media and credit budget.

### Existing production configuration

The release manifest takes precedence over `SYNC_CHATGPT_APP_DIR`. Existing
Porter pins to packaged hash directories no longer select the active release.
Stale pins to absent, pruned hash directories in the image are ignored.
Existing legacy bundles remain readable, including mounts under the packaged
root. The eight-retained-release budget applies to the deduplicated combined
manifest and legacy list. Configuration rejects overflow with an actionable
error instead of silently dropping resources. Retire unused bundles explicitly
before deploying if the combined list exceeds eight. Keep mounts until their
published resources can be retired.

Production already has widget-domain, CSP origins, API, and OAuth settings;
this change does not replace them. Keep `SYNC_BASE_URL=https://api.sync.so` and
the production MCP issuer. Keep existing upload routing, allowed origins,
storage configuration, and instance-affine upload-ticket routing.

For a new installation, configure `SYNC_CHATGPT_APP_DOMAIN`, exact
`SYNC_CHATGPT_APP_CONNECT_DOMAINS` and `SYNC_CHATGPT_APP_RESOURCE_DOMAINS`, and any
upload relay settings. The Docker image remains API-only when no widget domain
or legacy app directory is configured. Outside Docker, the legacy app directory
continues to support local development without a release manifest.

No production deployment or settings are changed by the local packaging command.

## Updating and retaining bundles

Build from an exact approved monorepo commit with its frozen lockfile:

```sh
pnpm install:local --frozen-lockfile
pnpm exec turbo run build --filter='@sync/chatgpt^...'
pnpm --filter @sync/chatgpt build
```

Copy `manifest.json` unchanged into a new `deploy/chatgpt/<sha256>/` directory.
Compress `app.html` deterministically (gzip mtime 0) as `app.html.gz`, and record
the source repository, full commit/tree, HTML SHA256/byte count, and build
commands in `release.json`, following the included release. Compare the
uncompressed hash to the approved artifact before review. Never replace an
existing directory with different bytes. Retain previous published directories
while cached clients still need them. Packaging permits nine releases total.

Update `deploy/chatgpt/releases.json` to select the new hash and retain published
hashes. Packaging rejects missing, undeclared, duplicate, or unsafe release paths.
The generated catalog is copied into the production image with the verified HTML.

Run `npm run build`, `npm run package:chatgpt`, and
`npm run verify:chatgpt-package`, then build/test the image as in CI. Review the
new provenance and artifact checksum in the PR. Deployment selects the manifest's current release; prior releases stay addressable through its previous list.

To roll back the UI, change the checked-in manifest's `current` to a retained hash,
move the newer hash into `previous`, and deploy through the normal workflow.
No Porter variable change is needed. If rolling back the entire image, ensure
that image also contains every UI resource still referenced by published or
cached tool metadata; an older image may not contain the newest bundle.


### Explicit unavailability checkpoint

IDEMPOTENCY_UNAVAILABLE now uses service availability copy and Retry original
request. Restored/unknown outcomes no longer assume a connection interruption.
The same key, frozen inputs, recovery handler and locks remain unchanged. A timeout
after unavailability restores the unknown-outcome message. The local test API
flag is enabled and preserved across Doppler restarts; production is unchanged.
Original Chrome request retry remains pending manual action, separate from the
passing source/artifact and API replay checks. No replacement generation submitted.


### Original voiceover continuation

Translate into another language restores the original source only for matching
project, video and prepared-audio lineage. Otherwise it retains submitted audio;
explicit cross-workflow switches still clear it. Final affected source/artifact
cases10/10, types/lint, clean artifact reproduction and independent review pass.
The same source is quoted after continuation and reload, with no automatic paid
translation or render. The previous recovery-message24/24 and API idempotency13/13
are separate retained evidence. Live original Chrome retry is still unverified.

The same private connection was refreshed to exact391c1d60 (6,194,778bytes).
Original live request retry remains unverified: reported button click has no
MCP/API generation dispatch and no new job/hold/deduction.
