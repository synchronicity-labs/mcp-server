# Claude tools and local-client release 0.2.0

Updated October 15, 2026. This is release evidence and an execution checklist,
not authorization to merge, deploy, publish or submit to the directory.

## Scope and revisions

- MCP PR #77: local login fixes, Claude Code plugin packaging, npm 0.2.0,
  and opt-in app metadata. PR #78 adds connected account/organization context.
- Both include main `ce16c5245983beda89826001526bb9133a85618a` (including
  Edit Dialogue, frontend recovery, discovery, voice cloning and shared session
  catalogs). PR #77 integration revision: `e44e4a7`. PR #78 code revision:
  `223d8bd`; subsequent documentation commits do not change that runtime.
  Preserve the selected ChatGPT artifact `670c3e5456b066ac7c184fde21dfe5c28fce284bae155992e38f0b8c61fed5b7`.
- API/web PR #6536 is merged into dev and production main. Claude dev consent acceptance passed
  with MCP `27bbc192`; see [acceptance](claude-acceptance.md). The merged release
  revision requires its own successful CI and target-environment smoke test.
- npm currently serves 0.1.4. Package, lockfile and plugin candidate versions are
  0.2.0. Legacy local credentials require one fresh login after upgrading.
- Keep `SYNC_CLAUDE_APP_MCP_URL` unset. Durable submission recovery, shared UI
  adaptation and actual embedded Claude app acceptance are separate launch gates.

## Release gates

- [ ] Current PR #77 and #78 revisions have passing verification, packaged-image
  and applicable security/review checks. The workflow includes stacked Claude
  branches; PR #78 previously received no verification run.
- [ ] Release reviewer approves the exact revisions. Merging to MCP main starts
  the production Porter deployment automatically; merge approval includes this
  consequence. Preparation and passing tests do not authorize that deployment.
- [x] The target production API has `/v2/oauth/account` and compatible OAuth
  behavior before PR #78 deploys. A 401 from an unauthenticated probe alone does
  not prove the authenticated contract. Confirm the deployed API revision and
  make an authorized account-context call.
- [x] Production Claude/Claude Code consent, denial, replay rejection and
  organization binding passed October 13 on candidate `6590ab4`; hosted Claude
  returned seven models. These are prior client results, not new runtime
  deployment evidence for the refreshed branches.
- [x] ChatGPT consent approval, denial and consumed-request rejection passed
  October 15. A real `models_get` call after consent reconnect returned seven
  models, corroborated by hosted MCP logs. See the navigation caveat below.
- [x] Production OAuth DCR, state, PKCE code exchange, selected organization,
  code replay rejection, invalid refresh-client rejection, HTTP Basic refresh,
  rotation, account stability and access/refresh revocation passed October 15.
  All tokens issued by that lifecycle harness were revoked afterward.
- [x] Revoked-membership behavior is covered by the API consent integration
  suite: approval/code exchange rejection, account/userinfo 401 and refresh
  rejection after membership removal. Its testcontainers CI passed in
  [API PR #6536](https://github.com/synchronicity-labs/sync-api-v2/actions/runs/37952599581/job/113895139247).
  Production memberships were not changed for acceptance.
- [x] The installed 0.2.0 tarball completed two fresh stdio processes against
  production using the existing API-scoped device credential. Both processes
  returned authenticated account context and seven models. The credential was
  unchanged. Plugin validation also passed. New-code hosted acceptance remains
  an after-deployment step, since deployment requires approval.

Production API deployment `3061b7e98692a7658a15da731ba1aef8500834ac`
[completed successfully](https://github.com/synchronicity-labs/sync-api-v2/actions/runs/38239577699)
and includes #6536. October 15 acceptance used API image `f330477`. With the
user's authorization, consent was temporarily enabled on that same image, then
restored to `false`. Rollback revision `6ff07365-f3a7-481a-a020-206b1849398b`
completed; all three API replicas were updated/ready on the same image and
ReplicaSet `5f78c8f6cd`, and a running process reported `false`. Doppler was
unchanged. No new MCP code was deployed and no generation ran in this pass.

## ChatGPT reconnect navigation caveat

OAuth itself succeeds. Reconnect with consent disabled and enabled both return
to a connected account screen; the server records a successful authorization
code exchange. Clicking ChatGPT's **Back to app** immediately afterward can
then display **Missing OAuth callback data**. Opening `https://chatgpt.com/`
directly and starting a fresh chat works; real authenticated model reads passed
after both flows. Do not repeat authorization or publish npm to address this
message. The remaining defect is in the host's post-callback navigation; its
internal cause is unconfirmed. Sync does not own that UI.

Reproduction for an upstream report: open Sync plugin settings, reconnect,
complete authorization, observe the connected account, then click Back to app.
Expected: return to the app. Observed: missing-callback-data toast, while the
connection remains usable. The error also reproduces with the old consent flow,
so it is not specific to the new consent page. No upstream report was sent.

## Combined candidate verification

PR #77 passed 575 tests locally. PR #78 passed 577 tests in 43 files after
integrating account context with the shared catalog; the updated assertions
check account-tool presence for every host. Lint, typecheck, build, ChatGPT
packaging and retained-artifact verification passed. The 0.2.0 tarball installed
successfully and its live stdio account/model smoke passed across process
restart. GitHub verification additionally covers parallel tests, bounded-heap
session checks, browser CORS upload, dependency audits and the final Docker
image. Require green checks on the exact current PR heads before merging.

Private evidence contains logs and screenshots; do not add credentials,
deployment manifests, account IDs or callback URLs to the release package.

## npm publisher setup

Configured and verified `npm-release`: only the `main` branch may deploy;
Noah Milberger (`nozma-knows`) is the required reviewer, with administrator bypass
disabled. The release owner may approve their own manually dispatched release.
Verify these rules before the first publication. No publish workflow was run.

A package owner must configure or verify this npm trusted publisher:

| Field | Required value |
| --- | --- |
| Package | `@sync.so/mcp-server` |
| Provider | GitHub Actions |
| Organization | `synchronicity-labs` |
| Repository | `mcp-server` |
| Workflow filename | `publish-npm.yml` |
| Environment | `npm-release` |
| Allowed action | Direct `npm publish` |

The npm settings were not authenticated or verified during preparation. GitHub
workflow files alone do not configure npm trust. Follow the
[npm trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/):
GitHub-hosted runners, npm >=11.5.1 and Node >=22.14.0. The workflow uses Node 24
and short-lived OIDC; do not add a long-lived publisher token.

## Execution after approval

1. The compatible API/web changes are already deployed. Obtain approval for
   the MCP merges/deployment and any persistent production consent enablement.
2. Merge #77, confirm its Porter deployment, then retarget #78 to main if needed.
   Re-run checks on the resulting revision and merge #78 after its API dependency
   and deployment approval are satisfied. Preserve Edit Dialogue and ChatGPT.
3. Verify hosted health, fresh Claude and ChatGPT account context, organization
   isolation, and the reviewed packaged UI. Leave Claude app presentation off.
4. Record the full reviewed final main SHA. Dispatch **Publish npm** from main
   with `version=0.2.0` and `revision=<full SHA>`. The workflow rejects a changed
   main revision and version mismatches, then runs prepublish checks.
5. Verify registry version, integrity and provenance. Install the published
   0.2.0 tarball into an isolated client and perform the approved login/tool
   smoke test. Validate Claude Code plugin installation from the main branch.
6. Preserve acceptance evidence. Directory submission remains separately gated
   by the requirements and owner in `claude-directory-readiness.md`.

## Rollback

Roll back hosted MCP to the last verified compatible image if acceptance fails;
keep accepted generation records, idempotency records and API account reads.
Disable consent before rolling back its web page. Leave Claude app metadata off.
A published npm version is immutable: prefer a corrective release or an approved
move of the latest tag to the previous known-good version. Do not delete or
re-submit paid jobs as part of rollback.
