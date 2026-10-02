# ChatGPT frontend release

The MCP production image includes the approved, self-contained frontend from
Sync's monorepo. It does not build Studio or fetch another repository at deploy
time. Activation still requires the environment configuration below.

## Included release

- Source: [sync-api-v2 a31411b8](https://github.com/synchronicity-labs/sync-api-v2/commit/a31411b8f38fa165f1903f3a489bb3e8db28c6fe).
- HTML SHA256: `5c28555d1843dfb74841ff1af3f5fff5cf8204f4ce52a8f6dabccbfc02d9c861`.
- Container directory: `/app/chatgpt-dist/5c28555d1843dfb74841ff1af3f5fff5cf8204f4ce52a8f6dabccbfc02d9c861`.
- Includes shared models, recording/uploads, generation overlays, Input/Output
  playback, and project history. The editor supports lipsync and image-to-video.

`deploy/chatgpt/<HTML SHA256>/` contains deterministic gzip-compressed HTML,
the frontend's original manifest, and source/build provenance in `release.json`.
Compression keeps the generated artifact small; the manifest hashes the
uncompressed HTML. The package is identical to the verified local release.

`npm run build && npm run package:chatgpt` expands and validates every included
release in `chatgpt-dist/`. Docker copies only that verified output to its final
image. No registry credentials, local environment files, or preview settings are
part of the frontend package. The Docker context excludes local environment
files, dependencies, and generated build outputs.

CI reads each packaged resource using an actual MCP client/server handshake in
the final production image with networking disabled. This proves artifact
delivery and protocol wiring, not production OAuth, storage, or generation.

## Activation after release approval

The existing `main` push workflow deploys through Porter. Merging a packaging
PR therefore deploys its image; this is not a preview-only merge. Before enabling
the UI, verify the production settings and keep the previous image/config for rollback.

1. Confirm the production backend supports project-filtered generation history
   on all instances. Keep `SYNC_BASE_URL=https://api.sync.so` and the existing
   production MCP issuer/OAuth settings for `https://mcp.sync.so/mcp`.
2. Set `SYNC_CHATGPT_APP_DIR` to the container directory above. Configure
   `SYNC_CHATGPT_APP_DOMAIN` using the verified production widget origin.
   Set `SYNC_CHATGPT_APP_CONNECT_DOMAINS` and
   `SYNC_CHATGPT_APP_RESOURCE_DOMAINS` to exact production origins. Include all
   media redirect destinations, not staging storage or ngrok origins. Recording
   blob playback and camera/microphone permissions are declared by the server.
3. If enabling the upload relay, configure `SYNC_APP_UPLOAD_ORIGINS` and
   `SYNC_APP_UPLOAD_STORAGE_ORIGIN`. Include `SYNC_CHATGPT_APP_DOMAIN` in
   `SYNC_CHATGPT_APP_CONNECT_DOMAINS` so the widget can PUT to `/app-upload` on
   that origin. Route that path to the MCP server and preserve instance-affine
   routing for process-local upload tickets. Verify the deployed routing and
   storage settings.
4. Set `SYNC_CHATGPT_APP_PREVIOUS_DIRS` to retained published bundle directories
   already included in the new image (at most eight). If production currently
   serves an externally mounted bundle, retain that mount or add those exact bytes
   before replacing its image/config. Do not substitute an unreviewed dev preview.
5. Deploy through the existing production workflow, verify startup and the
   served resource hash, then rescan the existing Sync plugin in OpenAI's portal.
   Keep published schemas and resource URIs working during review.
6. In a fresh ChatGPT conversation, verify authentication, both workflows,
   recording/upload, model selection, progress, playback/download, and history
   continuity with production Studio. Live generation uses the reviewer's
   approved account/media and credit budget.

No production settings or deployments are changed by the local packaging command.
The Dockerfile deliberately does not enable the app with environment defaults.

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

Run `npm run build`, `npm run package:chatgpt`, and
`npm run verify:chatgpt-package`, then build/test the image as in CI. Review the
new provenance and artifact checksum in the PR. Activation selects the new
directory; prior releases stay addressable when configured as previous directories.

Rollback selects the previous directory and retains the new directory for
clients that already cached its URI, provided both are in the image. If rolling
back the whole image, ensure its retained bundles still satisfy published
resource URIs. Never wait for an OpenAI rescan to fix a broken server contract.
