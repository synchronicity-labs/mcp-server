# ChatGPT frontend release

The MCP production image includes the approved, self-contained frontend from
Sync's monorepo. It does not build Studio or fetch another repository at deploy
time. The checked-in release manifest selects the active UI with each deployment.
Existing production origins and OAuth settings are kept.

## Included release candidate

- Source: [release CI checkout 0140adbb3](https://github.com/synchronicity-labs/sync-api-v2/commit/0140adbb3d83111790cbb11bf8a31fbe108f0a42).
  Its Git tree is identical to dev `a558d7d5e6b4f58d7dabdf19a64ab903e20cfa55`.
- HTML SHA256: `0f4f454753a88e6264cf1393500c9d9dac8673040459642407230a0e1ddbb258`.
- Container directory: `/app/chatgpt-dist/0f4f454753a88e6264cf1393500c9d9dac8673040459642407230a0e1ddbb258`.
- Adds the shared compact Edit Dialogue editor: timed-word changes, original-voice
  preview, undo/redo, waveform/playback, preview-based final pricing, and recovery.
  Workflow cards use two rows and two columns.
- Preserves existing estimates, Translate & Dub, project history and media inputs.
- Retains all three published releases: `a39e27ca488992ab54f148417646a041c7e6d667055dbc0fa5bcd674af76532b`,
  `c048cd48c1d3bde0c9fafb1dd3cdd9ccc6dd45085060a92ed653b7cfce7592dd`,
  and `5c28555d1843dfb74841ff1af3f5fff5cf8204f4ce52a8f6dabccbfc02d9c861`.
  All remain addressable for cached clients.

The bytes come unchanged from [frontend CI run 37779270942](https://github.com/synchronicity-labs/sync-api-v2/actions/runs/37779270942),
which used a frozen lockfile and passed all 228 development/artifact browser tests.
The artifact name, actual checkout, source tree and build commands are recorded
in `release.json`; this is a CI-built candidate, not a new local frontend build.

Production release is on hold pending Noah's pilot-flow acceptance of the full
monorepo batch and final release confirmation. Promote and verify required API,
worker and database changes before deploying this package. Package CI/review and
published ChatGPT acceptance are separate gates. See the
[release tracker](../plans/multi-pr/edit-dialogue-release-76.md).

### Initial project data

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
uncompressed HTML. The candidate package is identical to the verified CI artifact.

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
