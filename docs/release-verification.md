# MCP release verification

PR #60 contains the complete integration candidate plus the release review fixes.
The PR description records the current exact head and its validation evidence.
Any source or lockfile revision requires validation against the new head; earlier
Session E reports only attest to the exact revisions named in those reports.

## Component provenance

| Component | Included immutable head |
| --- | --- |
| PR #54: compatibility | ea4a608adc9b20b5deb9eacc3fdcca3428a3a963 |
| PR #56: cancellation | d8954dc9af2f3e82b270ca2388ca265941ab9eef |
| PR #57: verification | 0a4b71c74c9c635ca23d89ab7641f0e3c4700ce1 |
| PR #58: credentials | 943493a564047e36ea93ed88d07d66676c3ec006 |
| PR #59: session ownership | a44e9cef17dcdd305e443986e7f851974bf1c545 |
| Previous E-verified integration | 7be6329a7d09e96eea0fd0563debac7c089920c7 |

[Session E's previous exact-head report](https://linear.app/sync-labs/issue/CRAFT-6168#comment-5b306d82-3e81-4f2f-9e72-1d9e75e9ab19)
is historical evidence, not approval of subsequent release fixes.

## Reproducible checks

Use Node 22, matching the runtime container, with the committed lockfile:

```sh
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm run build
npm test -- --no-file-parallelism
npm test
npm audit
npm audit --omit=dev
git diff --check
```

The PR verification workflow checks its exact head with read-only repository
permissions. It does not deploy. Native loopback regressions exercise both
/token and /revoke success/error cache policy, ten-second stalled headers/body
timeouts, client disconnects, and no retries. Incomplete-spec tests compare
registered tool counts with the actual ChatGPT/Claude catalogs. Existing auth,
Origin, E1 ownership, refreshed identity and cancellation regressions remain.

The five-second userinfo timeout, ten-second OAuth exchange timeout, 65-second
tool API timeout and bounded upload runtime are separate mechanisms. A timeout
or disconnect does not undo a token rotation, generation or other accepted write.
Do not automatically retry an exchange whose outcome is unknown.

## Release and live review boundaries

Engineering approval belongs to the release reviewer (Noah). CI and agent test
results are evidence, not a substitute for that approval. Independent Session E
verification must name the revised release SHA. Component PRs remain open until
handled by the release owner.

The existing deploy workflow runs on pushes to main. Merging this PR may trigger
that deployment; approval to prepare or test the PR is not merge/deploy approval.

[Session C's reviewer kit](https://linear.app/sync-labs/document/muse-connector-launch-reviewer-kit-and-release-evidence-499e8a3c25d7)
tracks live fixtures and workflow evidence. Real Muse/Claude/ChatGPT acceptance
requires approved isolated organization and reviewer access, owned/consented
fixtures, numeric credit budget and expiry, cleanup owner, execution
authorization, and a verified deployed revision. Muse aliases/origins/native
attachments remain unverified; synthetic generic-client tests do not establish
those contracts. No controlled fixture tests spend production credits.
