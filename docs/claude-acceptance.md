# Claude acceptance and rollout

Evidence recorded October 8, 2026. This is a staged implementation, not a launch
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

## Remaining gates, in order

1. **Fresh client and paid workflow:** choose a test organization, approve a
   numeric budget, authenticate a new Claude connection, upload or select an
   approved fixture, estimate, submit once, poll, play/download, and verify the
   same generation and charge in Studio. Record client/server/API/artifact
   revisions and resulting IDs in private acceptance evidence.
2. **Account consent:** show authenticated identity, selectable authorized
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
6. **Distribution:** validate an installed npm tarball and a fresh Claude Code
   OAuth workflow, publish from the verified revision, and confirm the registry
   and installed version match. The local plugin marketplace is separate from
   Anthropic's reviewed directory.
7. **Directory:** preserve CRAFT-5421's owner, confirm the written policy
   exception, prepare the reviewer account and listing, and submit actual
   working-client evidence. No exception or directory acceptance is established
   by this release candidate.

## Rollback

Unset `SYNC_CLAUDE_APP_MCP_URL` to restore Claude's tool-only presentation. Keep
retained artifacts, OAuth, and recovery reads available. Accepted jobs and their
idempotency records must survive rollback. Revert the frontend selection using
the existing release manifest; do not delete recovery state or repeat paid work.
