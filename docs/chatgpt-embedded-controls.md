# Embedded voice, media import and result controls

Companion runtime support for CRAFT-7256. The frontend is reviewed separately;
the candidate frontend records its exact source commit/hash in
[release provenance](chatgpt-release.md), and all published resources remain
retained byte for byte.

`get-account-context` advertises `embeddedVoiceCloning` only when the connected
API exposes `voices_clone-voice`. That existing non-idempotent tool becomes
widget-callable. A form must confirm rights, sample and name, persist uncertain
outcomes, and reconcile through voice reads rather than retrying creation.
Returned Sync voice ids remain distinct from provider voice ids.

`get-generation-feedback` and `submit-generation-feedback` require a signed-in
account. Each checks current project access and exact terminal generation
membership before touching the feedback endpoint. This read check is necessary:
the API feedback GET itself filters by generation/user, not current organization.
The write forwards only rating, complete tags, optional text and text-pending
state. API validation owns tag vocabulary/polarity and persisted feedback.
The response omits internal user, organization and provider fields. Host profile
sets the surface; tool arguments cannot change it. Free text may be analyzed by
Sync. These tools do not create speech, clones, previews or video generations.

Changing the connected team still requires fresh OAuth consent. Browser code
must not send an organization override or handle credentials. Retained panels
must reopen after identity changes, preserving original recovery records.

Release only after both PRs are reviewed and the new frontend is packaged with
its recorded source/hash. Refresh tools and use a fresh ChatGPT panel, then
verify discovery, team identity and existing results without paid work. Real
clone quality/provider acceptance remains a separately approved test. Do not
merge or deploy from this document.


## Supported media controls

Voice deletion exposes the API's existing single-voice read and destructive
DELETE with the existing authenticated voice ownership checks. Account context
advertises `voiceDeletion` only when both routes are discovered. The panel uses
Studio's confirmation, clears a selected deleted voice, and journals uncertain
deletes before dispatch. Reload recovery reads the voice before any new explicit
delete; a missing response never causes an automatic DELETE retry.

Platform imports are additive adapters for detect, preview, start, status, list,
cancel and retry. The capability is advertised only for a complete API rollout.
Every operation verifies a connected user; the API owns current team/project
access, platform allowlists, SSRF protections, feature eligibility and quotas.
Caller-supplied account/organization overrides are discarded, and provider raw
metadata is excluded from responses. Start and retry are non-idempotent and
never repeat automatically. The panel persists a project/account/team-scoped
claim before admission, reconciles unknown jobs by paginated reads, resumes
polling after reload, and reads the canonical asset after completion. An explicit
retry snapshots failed matching jobs so a lost reply cannot recover an older
failed job; active/completed imports remain recoverable because the API can reuse them. Rights consent is required before the initial platform import.

Multi-file uploads reuse the existing sign/transfer/register routes serially.
Every selected file is attempted, valid siblings are saved even if another file
is invalid, and a partial result names the failed files. All successes appear in
Assets; the first successful file is selected deterministically after the batch.
Unconfirmed registration is surfaced for read-based recovery rather than
re-uploaded. Recording and audio extraction retain their single-file flows.

The source regression suite injects lost clone, deletion, import and retry
replies through the real MCP Apps bridge; transport integration tests exercise
a real MCP client and HTTP fixture. No paid/provider calls are required for
this proof. Live provider quality and production deployment remain separate.
