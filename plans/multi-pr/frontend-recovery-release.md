# Frontend recovery release

Tracks CRAFT-6796, CRAFT-6798 and CRAFT-6676. Source feedback:
https://sync-labs-workspace.slack.com/archives/C05NMQGDJ11/p1791880980251309

## Candidate

CI artifact `sync-chatgpt-304093ed83e1b5eb1090968f8d9af9d7a8e17944` from
https://github.com/synchronicity-labs/sync-api-v2/actions/runs/38413950994
contains the merged PR #6723 generation/recovery repair and PR #6657 partial
host-state restoration. The CI checkout and merged main PR #6722 have identical
Git trees. Artifact browser tests passed: 250; skipped: 4.

Active HTML hash: `670c3e5456b066ac7c184fde21dfe5c28fce284bae155992e38f0b8c61fed5b7`.
Retain all four previously published bundles unchanged.

## Release gates

- [x] Verify downloaded HTML against its original manifest checksum.
- [x] Verify CI checkout tree equals merged main release tree.
- [x] Confirm CI artifact tests cover standard/legacy host refusals, recovery
  identity, repeated reloads and partial host-state restoration.
- [ ] Pass MCP package/protocol verification and final-image CI on this PR.
- [ ] Review and merge the package PR; main automatically deploys through Porter.
- [ ] Verify production selects the new resource URI and retains old resources.
- [ ] Rescan the publisher if needed and verify the new resource registration.
- [ ] Complete the real ChatGPT acceptance below using the new resource.

## Real ChatGPT acceptance

Local fixtures and CI are not evidence of published-host success. Before testing,
record account, connection context, model shown, resource hash and timestamp.
Use the previously approved short test asset or existing test-project media.
Do not modify unrelated user projects or run paid jobs without separate approval.

1. Open the full app in a fresh conversation; check project loading and navigation.
2. Select/upload video and audio; confirm media, duration, model and estimate
   remain usable, without duplicate uploads or hidden required controls.
3. With an approved budget, submit exactly one generation from saved assets.
   Verify `create-lipsync-from-assets` is called and the host file-parameter
   rejection is absent. Record its generation ID and poll that ID to completion.
4. Verify result playback and history, then reload and reopen the same project.
5. If a request is declined before dispatch, verify the explanation and editable
   saved inputs. Never manufacture an uncertain paid operation in production.
   Lost-response/unknown-outcome regressions remain covered by fixture tests.
6. Check that recovery gives visible progress and preserves the original key;
   never retry a paid request with a new key merely to make a test pass.
7. Record chat/panel alignment, multi-speaker messaging, Studio handoff and layout
   separately. This release does not claim to implement the outstanding UX work.

## Rollback

Select retained hash `0f4f454753a88e6264cf1393500c9d9dac8673040459642407230a0e1ddbb258`
as current, retain the new hash in previous, and deploy through the same workflow.
Do not overwrite immutable bundle bytes or remove resources cached by ChatGPT.
Plugin package 2.0.2 publication is unrelated to activating this frontend.
