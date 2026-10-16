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

## October 16 paired checkpoint

Current candidate is source 17338e6b9, packaged exactly as recorded in
`docs/chatgpt-release.md` and the current immutable `release.json`. All eight older
resources remain. Final scoped browser/API checks pass; real private-plugin
completion/history/playback/OAuth refresh are verified on the earlier candidate.
The same private connection is refreshed to the exact final hash and verifies
saved inputs, free duration preflight and visible disabled controls.
Current-head CI/reviews, native dev merge conflicts and the
remaining full acceptance matrix still gate merge. No merge/deploy authorized.


## Processing transition and draft checkpoint

Source/artifact acceptance passes 26/26; final frontend types/lint and independent
preservation/Ponytail review pass. The candidate keeps one authorized processing
frame, removes duplicate speech status, adds supported processing workflow choices
and shows the single current local draft in history. The same existing private
plugin serves this exact resource, reopens saved translation inputs, presents the
current draft row and plays the owned completed take. OAuth refresh succeeds.
Processing states remain fixture proof; no fresh live processing job was started. Full multi-draft behavior,
completed-output forwarding and the other declared merge gates remain open.
No merge, deploy, production plugin change or new paid generation.


## Translation recovery and historical output checkpoint

The packaged source/artifact cohort passes44/44, including origin-preserving
translated-audio recovery, legacy project fallback and historical playback/control
bounds on desktop/mobile. Frozen request arguments/keys and fresh access gates
remain unchanged. Types/lint and independent preservation/Ponytail review pass.
The eight prior immutable packaged resources remain byte-identical. This candidate
replaces only the prior unmerged candidate. No merge or deploy.

Same private connection refreshed to058849bd. The current draft is selectable;
owned historical output78ab3dbe plays to28/28frames with controls inside the
actual392px host stage. Screenshot: private-history-output-final.png under
/Users/noahmilberger/.codex/visualizations/2026/10/16/pr6822-processing-drafts/.
No additional generation started.


## Explicit unavailable recovery checkpoint

Current sourcee512811fe distinguishes service unavailability from unconfirmed
outcomes without changing recovery identity or admission. Browser24/24, affected
fixture rerun10/10 and API idempotency integration13/13 pass; final types/lint and
independent review pass. All eight retained resources remain unchanged. Local
flag setup is corrected; original Chrome retry awaits manual action. No live
retry success, merge or deployment is claimed.


## Original voiceover follow-up

Current sourced8b45175f fixes the reviewed another-language source loss through
exact saved project/video/prepared-audio lineage. Baseline failed before repair;
source/artifact10/10, types/lint and preservation review pass. Same immutable API
request/keys and fresh access gates remain. Original live Chrome retry is still
unverified. No merge/deploy.

Same private connection refreshed and fetched exact391c resource. The original
Chrome retry still has no MCP/API dispatch evidence and no new charge/job. Its
UI error/state is the outstanding live-test input. No implicit retry is run.


## Dev integration checkpoint

Source `faa89a077f118982bc43388562da35cd53ab1ae6` / HTML `a1dd3d4a805c9f401132b2c494a470b068a74bbf96f73726de331cc0e0385597` (6,198,861 bytes)
merges dev `73e96081e` while preserving shared translation controls and upstream
authorization, multi-speaker validation, preview comparison and history fixes.
Native integration77/77, native browser24/24, affected type/build34/34, changed
lint/boundaries and exact generated clients pass. Independent preservation and
Ponytail review is clear. No MCP runtime code changed; all eight retained
resources remain byte-identical. The isolated source/artifact cohort passes12/12
at original timeouts, and its rebuilt bytes match the frozen candidate exactly.
The earlier concurrent run timed out under memory pressure. Local duplicate
React scan was interrupted, not passed; exact-head React, package/protocol proof
and CI/reviews remain required.
Original live retry and full parity acceptance remain open. No merge/deploy.

Final build/package/protocol verification passes for all nine resources through
a real MCP client/server. All eight retained releases are byte-identical. Native
CI complexity finding is repaired by deleting a redundant config-selection
predicate; full-config file lint/format and28 lifecycle tests pass, with clear
independent preservation review. No runtime MCP changes. Exact-head CI/reviews
(including React), original live retry and full parity remain open gates.

Retention review confirms that replaced candidate391c was never selected by
production. The private test server explicitly uses its independent frozen391c
directory and retained-resource list, without the deployment catalog. Those
files and the running server remain unchanged. A future upgrade of that same
private connection must retain all issued resources and reconcile the lists
within the existing retention limit before changing its configuration.
