# ChatGPT frontend release

The MCP production image includes the approved, self-contained frontend from
Sync's monorepo. It does not build Studio or fetch another repository at deploy
time. The checked-in release manifest selects the active UI with each deployment.
Existing production origins and OAuth settings are kept.

## Draft model-context repair candidate

- Source: [frontend PR #7216](https://github.com/synchronicity-labs/sync-api-v2/pull/7216), commit `c779121ba7e00bd3e7c38200c79a09b4ddf6a2f5`.
- UI SHA256: `f0dd696d03bfdae09580de317d4cb9a9ecf8f4b761dffc77111f0c02d17617ab` (3,957,179 bytes).

The expanded editor publishes its current project and draft through the standard
MCP Apps model-context channel even when widget storage is available. The
frontend serializes delivery, retries a rejected publication on a later draft
refresh, and preserves private recovery when a host reuses the widget-state slot.
No private recovery journal is included in model context.

The new resource and all ten resources published through #94 pass actual MCP
client reads. All 30 existing resource files and the three archived files remain
byte-identical. The retention bound increases by one to ten previous resources,
eleven total; session admission and memory limits remain unchanged. No bundle is
retired by this release.

Review and release the exact frontend source before this MCP package. Its base
is current dev, so the coordinated release must account for its shared-package
changes as well as the context fix. The draft API already advertises version 1;
this repair adds no API route, migration, OAuth setting, or provider operation.
After deployment, refresh publisher metadata and the test connection, open a
new expanded Studio, and confirm chat can select existing media with the
published draft ID. Local host tests do not establish production ChatGPT acceptance.

## Published draft synchronization release (#94)

- Source: [API/frontend PR #7144](https://github.com/synchronicity-labs/sync-api-v2/pull/7144), commit `ab8edec11f3dc24061176cb45e25a75943d284b7`.
- UI SHA256: `f5866028123de7ad70b806c1e3c24f59a111ab11e38ad2f8337cd56cae9dd811` (6215309 bytes).
- All 27 files in the nine resources published by merged MCP #91 are unchanged.

This candidate adds authenticated read/update draft tools and app-only save and
acknowledgement tools. The API stores revisions per account, organization,
project and draft. Chat updates remain pending until Studio validates the media,
saves recovery state and acknowledges the exact revision. Conflicting local
changes require a choice in Studio. No draft tool starts provider work.

Workflows, search and projects now use the web dashboard's centered 880px
content limit while the viewport retains full-height scrolling. Six packaged
layout cases pass across mobile, tablet and wide hosts in inline/fullscreen
modes. The application JavaScript is unchanged from the preceding 40-case
source/artifact functional acceptance at `46b5ac827`.

MCP #91 merged externally as `8099c271c04c0c6671557c02c4fc169d1abef286` on
October 22 at 20:40 UTC. This companion now targets main and preserves its account
usage/project-renaming tools and published frontend resource `55adb4a8`. The
October 2 resource remains archived exactly as approved in #91. This change
introduces no further retirement. The deployed #93 memory fix is retained.

Release order: deploy the companion API/frontend PR and its additive migrations,
then deploy this reviewed MCP companion. Discovery advertises synchronization
only when all three versioned API routes are available. Older servers keep local Studio editing.
After deployment, rescan the ChatGPT connection and use a fresh Studio widget.
No production rollout or paid generation has been performed for this candidate.

The retention ceiling increases by one previous bundle to retain the deployed
current UI as well as all eight resources retained by #91 when the new UI is
packaged.
Existing resource bytes remain unchanged. The total remains bounded at ten,
and the session memory guard, pressure GC and shared validators are unchanged.

The draft tools reuse their save/acknowledgement schemas for discovery and
validation. Capability checks return a boolean directly, preserving the same
version, method and operation-ID requirements without collecting unused
operation arrays. The API companion keeps policy in its draft service.

The dependency override requires `ip-address` 10.7.4 or later, and the lockfile
selects 10.7.4 to address [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5).

## Earlier published release

- Source: [PR #6822, commit 48247d3f](https://github.com/synchronicity-labs/sync-api-v2/commit/48247d3f6e2b97ec1793b21a5eb9eecaf036b3cb).
- Accepted API squash merge: `cf0b2d21805dc6877628d28e4f146acd02d37d7f`.
  Comparing that merge with the recorded build source changes only CI, scripts
  and docs; `apps/chatgpt` and `packages` are byte-identical. The source commit
  remains the actual build provenance and the UI needs no rebuild for the squash.
- The API changes reached production in [release PR #7029](https://github.com/synchronicity-labs/sync-api-v2/pull/7029),
  commit `3e76c86d9fe3595a0cb2ea58772b717384b99464`.
  [Production run 39591510089](https://github.com/synchronicity-labs/sync-api-v2/actions/runs/39591510089)
  completed successfully on October 21, 2026 at 11:36 UTC. MCP PR #88
  subsequently merged as `f5bec66267b5d065dc273928d10aa968eb249fe6`;
  its production deployment succeeded. The later #90 metadata-only deployment
  also succeeded and kept these frontend bytes.
- HTML SHA256: `a2c7ca49387511cc2d73a107b0bdd9a7e724fa29ad15e65c4c2a75b538305672`; HTML size: 6,198,052 bytes.
- The current follow-up supplies explicit image dimensions in history, matching
  the existing image-stage convention. Absolute full-stage containment and
  original image/video selection remain unchanged. Full AI-friendliness,
  ChatGPT typechecking, focused lint/formatting and four source/artifact browser
  cases pass. Clean committed rebuild matches the tested bytes exactly.
- The preceding `7513efcc` integration includes dev `dcc90dcd5` and passes 272
  native dialogue tests, 14 dialogue source/artifact browser cases, all 34
  type/build tasks and full lint/format/boundaries. Its full pinned native React
  scan passes 100/100 with all 2,403 files analyzed and zero diagnostics. Native
  web and shared owners are byte-identical in this ChatGPT-only attribute change.
- Native multi-face analysis remains advisory; diarized speaker count alone
  refuses unsupported dialogue. Shared loader timing and cleanup, the native
  warning slot, overlap repair, quote/source/account/recovery fences and atomic
  credit/pilot reservations remain preserved.
- The earlier `2e8fc6ca` checkpoint passed 493 native tests, 526 common tests,
  six native browser cases and 14 history/navigation source/artifact cases.
  Its real-Toaster and image-history regressions demonstrated RED then GREEN.
  Earlier database/provider proofs remain separately named historical evidence,
  not rerun counts or exact-byte live acceptance of this candidate.
- At the image-dimension packaging checkpoint, MCP runtime was unchanged from
  the earlier 607-test runtime checkpoint. The recovery follow-up below changes
  MCP runtime and must pass the current revision's tests and CI. All nine
  actual MCP resource reads pass, and all 24 files in eight retained published
  releases remain byte-identical. Only the unmerged candidate is replaced and
  backed up locally. The latest review results are on PR #88; each follow-up
  requires CI and reviews of its own revision plus independent human approval.

## MCP recovery follow-up

Submission lineage checks now verify only accessible project identity and exact
parent/project membership. A deleted, unrelated parent asset or legacy parent
settings cannot prevent an identical keyed request reaching the API's replay.
The key, headers and submitted inputs remain unchanged. Missing, malformed or
foreign parents and revoked project access still fail before a submission.
The full `get-generation-continuation` read keeps its source-access checks and
media projection. New generation inputs remain subject to API authorization.

The focused HTTP regression covers response loss followed by deletion of an old
parent source, legacy parent settings, unchanged replay inputs, rejected parent
identities and access revoked before retry. The UI bytes and all retained
resources are unchanged by this MCP runtime fix. Local verification passed all
614 MCP tests, lint, typecheck, build, normal/burst memory checks, the upload
browser test and all nine actual MCP resource reads. Full and production-only
audits report zero vulnerabilities after updating the affected SDK, Hono and Vite
lockfile resolutions within the existing declared ranges. CI and fresh reviews
still apply to the pushed revision; none of these checks proves live ChatGPT
acceptance.

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
   `current` selects the active HTML hash; `previous` retains up to ten older hashes.
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
root. The ten-retained-release budget applies to the deduplicated combined
manifest and legacy list. Configuration rejects overflow with an actionable
error instead of silently dropping resources. Retire unused bundles explicitly
before deploying if the combined list exceeds ten. Keep mounts until their
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
while cached clients still need them. Packaging permits eleven releases total.

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
