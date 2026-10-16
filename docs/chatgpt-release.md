# ChatGPT frontend release

The MCP production image includes the approved, self-contained frontend from
Sync's monorepo. It does not build Studio or fetch another repository at deploy
time. The checked-in release manifest selects the active UI with each deployment.
Existing production origins and OAuth settings are kept.

## Included release candidate

- Source: [PR #6822, commit205baba3c](https://github.com/synchronicity-labs/sync-api-v2/commit/205baba3ca78b471a18522ab57eef5e51ad415b0).
- HTML SHA256: `9d17542288b1a6048cce73a9747018a4dee84c985784d3b6e2facd04e95b07d1`.
- HTML size:6,177,475bytes. `release.json` records the exact source commit/tree,
  local build commands and scoped verification. These are local candidate bytes,
  not a downloaded CI artifact. Current-head full CI/reviews must pass before merge.
- Uses the actual shared Studio media, speech, translation, dialogue, assets and
  history views, with MCP adapters. The compact editor keeps media controls
  reachable when ChatGPT reserves space for its composer.
- All16 focused source/artifact browser cases pass. This covers compact controls,
  import navigation locks, history polling/focus and completed upload routing;
  it does not establish every workflow state or full visual parity.
- Six additional source/artifact asset-preview cases pass at390,498and1280px,
  including host resizing and pointer selection. The pinned React web gate is100/100.
  Actual ChatGPT verifies preview containment and selection above its composer.
- In the private isolated ChatGPT test plugin, real speech, lipsync and dialogue
  completion, canonical lipsync/dialogue history after full reload, recovered
  video playback and automatic OAuth refresh were verified.
  A bounded Spanish translation also completed and its saved audio played.
  Translation reload recovery remains under investigation; it is not accepted.
  Local playback required a token-protected test ingress and accepting ngrok's
  one-time browser notice. No production configuration was changed.
- Definite402 quota refusals reuse Studio's typed error mapper and toast policy,
  preserve media, and leave explicit retries available. Unsupported action labels
  fall back to Open in Sync with the exact project/generation URL. Both regressions
  fail before repair; all10 focused source/artifact cases, types, lint and the
  full pinned React gate pass. Independent preservation review is clear.
  Actual refreshed ChatGPT shows friendly quota copy with inputs retained; the
  owned generation count remains2 before/after refusal. No job or upgrade.
- Retains the previous current bundle `feb7f2a9acbe951d81472ce6cc148727f7090abd3f278d93709fd7ec53474840`
  and all five older bundles unchanged, so cached resource URIs remain readable.

This is a paired PR candidate, not production acceptance. Deploy compatible
backend support before MCP activation. Finish current-head CI/reviews and the
remaining workflow acceptance checklist before merge or deployment. No merge,
publish or deployment is authorized by this preparation. Updating hosted tools
and this HTML does not itself require publishing plugin package2.0.2.

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
