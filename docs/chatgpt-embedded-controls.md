# Embedded voice cloning and result feedback

Companion runtime support for CRAFT-7256. The frontend is reviewed separately;
the packaged frontend from MCP #91 remains unchanged in this PR.

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
