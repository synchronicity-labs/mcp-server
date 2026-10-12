# Claude tools and local-client release 0.2.0

Prepared October 12, 2026. This is release evidence and an execution checklist,
not authorization to merge, deploy, publish or submit to the directory.

## Scope and revisions

- MCP PR #77: local login fixes, Claude Code plugin packaging, npm 0.2.0,
  and opt-in app metadata. PR #78 adds connected account/organization context.
- Both include main `599d790` (Edit Dialogue). Do not replace the newer ChatGPT
  artifact with the older artifact used in the first Claude test.
- API/web PR #6536 is merged into dev. Claude dev consent acceptance passed
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
- [ ] The target production API has `/v2/oauth/account` and compatible OAuth
  behavior before PR #78 deploys. A 401 from an unauthenticated probe alone does
  not prove the authenticated contract. Confirm the deployed API revision and
  make an authorized account-context call.
- [ ] Claude and ChatGPT target-environment login, denial, organization binding,
  refresh and revoked-membership acceptance pass. Dev Claude UI acceptance and
  backend integration coverage are recorded separately; do not conflate them.
- [ ] Fresh Claude Code OAuth acceptance passes. Prior plugin validation and
  isolated install/uninstall prove packaging, not the entire client workflow.

## npm publisher setup

At preparation time the GitHub environments API returned no environments. Create
`npm-release`, restrict it to main, and require a release reviewer before dispatch.
Verify the environment protection rules before the first publication.

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

1. Deploy the compatible API/web changes using their staged consent rollout.
   Verify the production account endpoint and web route before enabling consent.
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
