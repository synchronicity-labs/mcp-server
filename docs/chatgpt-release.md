# ChatGPT frontend release

The MCP production image includes the approved, self-contained frontend from
Sync's monorepo. It does not build Studio or fetch another repository at deploy
time. The checked-in release manifest selects the active UI with each deployment.
Existing production origins and OAuth settings are kept.

## Included release candidate

- Source: [PR #6822, commit 2e8fc6ca](https://github.com/synchronicity-labs/sync-api-v2/commit/2e8fc6caaffeb30fc814c33a49443651b3732456).
- HTML SHA256: `d73a5f0954c585c714f87eb89861e18dd9cf877e47a945647aa537bb00fa79ec`; HTML size: 6,197,979 bytes.
- Integrates dev `2f5520ffa`, preserving the incoming overlapping-audio repair,
  optional voice-match takes, exclusive shared playback, canonical quote policy,
  archived translation/continuation ownership, server allowance policy and atomic
  credit/pilot reservations.
- Restored Library seeds recheck access before preview/attachment, refresh metadata,
  refuse stale team responses and retain recovery through project persistence.
  URL-only original images in history now use the shared image preview; original
  videos keep their playback and source/synced switching behavior.
- Current verification passes 493 native tests in 13 files, 526 common tests,
  34 type/build tasks, full lint/format/boundaries, six native trim/audio-removal/
  recovery browser cases and 14 source/artifact history/navigation browser cases.
  The full pinned React scan passes 100/100 with all 2,403 files analyzed and zero
  diagnostics. The committed rebuild matches the tested bytes exactly.
- Real app toast regressions demonstrated both overlap and pending refusals fail
  with split module constructor identity, then pass through the canonical shared
  entry point. Both URL-only image history cases demonstrated RED then GREEN.
  Independent preservation/test-audit/Ponytail review is clear.
- Previous `c3c1b07d` proof includes 215 native tests, 28 uploader-stack tests,
  three real asset-history database tests, 35 dialogue-cut tests, 14 native browser
  cases and 40 plugin source/artifact cases. The preceding `7ad6544e` integration
  passed 159 real database tests across seven suites. These remain named earlier
  proofs on preserved owners, not claims that every suite reran on this candidate.
- MCP runtime is unchanged; its prior 607 passing tests remain applicable.
  All nine current/retained resource reads pass through an actual MCP client/server
  handshake. All 24 files in eight retained published releases remain identical;
  only the unmerged candidate is replaced, with the prior candidate backed up.

## Earlier live acceptance

The following records apply to their named candidates. They are historical
acceptance, not exact-byte live acceptance of the current bundle.

- The existing private test plugin was refreshed to the prior `7cc55ade` bytes.
  It refuses exhausted free allowance and disables a fresh Sync submission while
  preserving the accepted script, Bella voice and saved audio. Completed history
  reopens and plays the real 6.32-second output without media error. The edited
  dialogue preview also survives reload and plays all 11.35 seconds without
  another synthesis. Final reads leave three completed generations, three speech
  jobs, one dialogue preview job and zero credit transactions.
- Earlier in the same acceptance session, private candidate `94c5fed2` verified
  a real provider generation through completion, a definite 503 followed by an
  explicit 201 retry with identical key/body fingerprints, and automatic OAuth
  refresh followed by protected reads. The documented local completion bridge
  forwarded the provider's real terminal status. Only the isolated fixture's
  protected-result URL origin was repaired to the test tunnel; its path, token,
  output, status and billing were retained. Both native Studio and the plugin
  played that same output. These admission/refresh checks are distinct from
  the final `7cc55ade` read/playback/allowance checks above.
- Prior `17a21ffb` evidence covers its own continuation/translation browser and
  private-plugin states; it is not exact-byte acceptance of this candidate.
  Only the latest unmerged candidate is replaced. All 24 files across the eight
  published retained releases remain unchanged, and private rollback files remain
  available. Refresh the existing private connection in place.

Current-head CI/reviews and MCP human approval remain merge gates. No purchase,
quota reset, merge, publish or deployment was performed. Fixture browser checks,
private-plugin reads and prior provider acceptance are distinct evidence; they
are not a claim that every paid workflow or production configuration was tested.

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


## Recovery behavior

Explicit `IDEMPOTENCY_UNAVAILABLE` refusals use service-availability copy and
Retry original request. Unknown outcomes keep recovery controls without assuming
that a connection interruption occurred. Keys, frozen inputs and locks remain
unchanged. A timeout during retry returns to unknown-outcome recovery.

Translation into another language restores original audio only for matching
project, visual and prepared-audio lineage; otherwise it retains submitted audio.
Explicit cross-workflow switches clear unrelated editor state. The isolated
private-plugin same-key retry described above is separate from historical
Chrome-local manual tests and source/artifact recovery fixtures.
