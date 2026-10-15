# Claude acceptance and rollout

Evidence recorded October 8–15, 2026. This is a staged implementation, not a launch
approval. The hosted baseline was MCP main `8d931ae`; the shared frontend/API
implementation baseline is dev `b635f01139ba`.

## Confirmed live

- Existing Claude web Sync connector reconnected and displayed Connected with
  16 tools. This was a refresh of an existing connection, not a clean install.
- Claude web called `models_get` after Allow once and returned seven models.
- A separately initiated Sync device-auth approval returned a session token and
  active organization; authenticated `/v2/models` returned HTTP 200.
- `/v2/organizations/current` matched the device-auth organization.
- The installed 0.2.0 tarball completed a real stdio MCP handshake and returned
  the live model catalog using the freshly approved device-token cache. Before
  the bearer-source fix, that same check returned HTTP 401.
- No media was uploaded and no paid generation was submitted during these checks.

Keep credentials, device secrets, media URLs and account identifiers out of this
file. Local evidence belongs to the testing task, not the published plugin.

## Full catalog acceptance

The [October 15 full-tool matrix](claude-full-tool-acceptance-2026-10-15.md)
records actual Claude Code HTTP/OAuth calls against the isolated 0.2.0 candidate
and production API. It supersedes earlier discovery/smoke coverage. The matrix
states paid workflow outcomes and negative cases separately and does not claim
that every tool has been tested in Claude web.

## Subsequent hosted acceptance

- The approved hosted Claude lipsync test completed one generation, with one
  recorded $0.075 charge. Download and full MP4 decoding passed. This was the
  tool workflow; it does not establish embedded Claude app acceptance.
- API/web PR #6536 is deployed to dev. The separate Claude dev connector
  completed fresh DCR and PKCE, explicit organization selection, denial and
  consumed-request rejection using MCP PR #78 at `27bbc192`.
- Claude's actual `get-account-context` response matched the selected dev
  organization. Reconnecting to a second dev organization changed that response;
  Studio's active organization stayed unchanged after full reloads.
- An unused request loaded at 593 seconds; a decision submitted at 608 seconds
  was rejected. Reload also rejected the expired request. Viewing the request
  midway did not extend its original expiry. No generation ran during consent
  acceptance, and no production consent setting changed.
- These live results attest to the revisions tested. The release branch now
  also includes main's Edit Dialogue changes; CI and packaged-client validation
  must cover the combined revision before release.

See [0.2.0 release preparation](claude-release-0.2.0.md) for release order,
publisher setup and gates that remain open.

## This release candidate

- Device auth follows `expiresIn`, `interval`, and terminal `expired` responses.
  Requests and the polling loop have deadlines. Invalid successful responses
  cannot enter the credential cache.
- Bearer requests retain `mcp`/`mcp:<client>` attribution so the deployed API
  selects its bearer authentication path. Client presentation remains separate.
- Cached credentials are isolated by API base URL, written atomically with mode
  0600, and can be removed using `--logout`. Legacy unscoped credentials require
  a fresh login, because their intended API is unknown.
- Claude Code plugin validation and isolated marketplace installation succeeded
  with client 2.1.251. The installed plugin resolves the remote Sync MCP URL.
  Uninstall also succeeded. This is install evidence, not a fresh Claude Code
  OAuth/generation test.
- `SYNC_CLAUDE_APP_MCP_URL` opts Claude into standard app descriptors and resource
  metadata. It is unset by default. Current and retained HTML keep their hashes;
  each session receives its own host metadata. Claude still cannot call OpenAI
  attachment upload tools or read their resource.
- npm 0.2.0 is prepared locally. Publication requires the reviewed commit on main
  and matching npm trusted-publisher settings for `publish-npm.yml` and the
  `npm-release` GitHub environment. No publication was performed.

## Workstream gates and remaining scope

1. **Fresh client and paid workflow:** hosted tool generation is verified above.
   Fresh Claude Code OAuth passed October 13. Embedded app acceptance remains. Choose a test organization, approve a
   numeric budget, authenticate a new Claude connection, upload or select an
   approved fixture, estimate, submit once, poll, play/download, and verify the
   same generation and charge in Studio. Record client/server/API/artifact
   revisions and resulting IDs in private acceptance evidence.
2. **Account consent:** Claude dev acceptance is verified above; production Claude,
   Claude Code and ChatGPT acceptance are recorded in the October 15 release report.
   Show authenticated identity, selectable authorized
   organizations, requested capabilities and denial. Validate membership and
   the complete OAuth transaction at confirmation, then bind the code/token to
   the selected organization. Do not silently change the Studio active org.
3. **Durable recovery:** store the frozen paid action and UUID on Sync before
   submission; discover unresolved actions by authenticated user/project;
   reuse `GenerationSubmissionsService` for execution and deduplication. Lost
   responses, iframe/client restarts and reconnects must recover one job/charge
   without `window.openai`. Preserve legacy ChatGPT recovery during rollout.
4. **Shared UI:** display account context; use standard host capabilities for
   compact/fullscreen layout, file picker, playback and downloads. Verify actual
   storage CORS/CSP, redirects, reloads and denied recording permissions. Update
   skeletons and test both source and packaged HTML without OpenAI globals.
5. **Deploy:** roll additive API changes to all pods, release compatible MCP
   tools, publish the reviewed frontend artifact, then opt Claude into app
   presentation. Configure exact observed sandbox/upload/media origins. Keep
   OpenAI attachment support separate. Never point the relay at the sandbox.
6. **Distribution:** installed tarball and fresh Claude Code OAuth validation have
   passed. After approval, publish from the verified revision and confirm the registry
   and installed version match. The local plugin marketplace is separate from
   Anthropic's reviewed directory.
7. **Directory:** preserve CRAFT-5421's owner, confirm the written policy
   exception, prepare the reviewer account and listing, and submit actual
   working-client evidence. No exception or directory acceptance is established
   by this release candidate.

## Rollback

The [October 15 release report](claude-release-0.2.0.md) supersedes earlier pending
auth checks: production token lifecycle and ChatGPT read-only acceptance passed;
the ChatGPT Back to app caveat has a verified fresh-chat workaround. The temporary
production consent test was rolled back to false. No merge or publication is
authorized by those test results.

Unset `SYNC_CLAUDE_APP_MCP_URL` to restore Claude's tool-only presentation. Keep
retained artifacts, OAuth, and recovery reads available. Accepted jobs and their
idempotency records must survive rollback. Revert the frontend selection using
the existing release manifest; do not delete recovery state or repeat paid work.
