# Maintainer notes

Operational details for the hosted server: client compatibility, cancellation,
the OAuth proxy, generation recovery, the embedded Sync app, uploads, availability
monitoring and cost reporting. Moved out of the README, which covers using the server.

## Hosted client compatibility

Hosted sessions select one immutable presentation profile after MCP initialization.
Exact ChatGPT aliases retain the upload widget, file metadata and optional file arguments.
All hosted clients can discover models (`models_get`), search/list and read projects
(`projects_get-all`, `projects_get`), search/list and read assets (`assets_get-all`,
`assets_get`), list organization generation history (`generate_get-generations`),
and estimate cost (`generate_estimate-cost`). These tools use the API's OpenAPI
contracts and the caller's existing Sync permissions. Lists retain the API cursor
parameters. ChatGPT can also call these tools from its UI.

When the backend advertises project filtering, `projects_get-generations` provides
history for one required canonical `projectId`, with the same cursor and limit
parameters as the public API. It verifies project access before reading history
and rejects responses containing another project's records, including responses
from an older API instance during a rolling deployment. The organization-feed
tool remains available on older backends. Deploy the compatible backend to every
instance, then restart MCP to refresh its OpenAPI catalog before enabling project
history in the app. This does not create a second plugin or a mirrored database.

Claude and unknown clients also expose `create-lipsync`, `voices_get-voices`, and
`generate_get-generation` for public/Sync-hosted URLs and existing Sync asset IDs.
Upload local media in authenticated Sync and use **Copy ID** in the same organization,
or **Copy URL**. Unsupported file/widget calls return this guidance without uploading.

Defaults are `ChatGPT generations`, `Claude generations`, or `Sync generations` for
unknown clients. Supply `projectId` to select an existing project by its canonical ID,
or `projectName` to find or create a named project. These fields are mutually exclusive.
An explicit project ID is checked for access before any file transfer; an inaccessible
or deleted project fails without falling back to a new project. Muse remains an unknown client until its
actual handshake alias is verified. Client names affect presentation only, never
organization access or credit permissions. No Muse origin or attachment contract is assumed.

## Request cancellation

Explicit MCP request cancellation propagates to project lookup, upload admission,
file transfer, asset registration, generation submission, and generated API tools.
The server checks cancellation before starting another write. Tool API calls have
a 65-second transport deadline; generation polling uses the API default wait window;
upload queueing and transfer retain their configured upload deadline.

Cancellation cannot undo a write already accepted by Sync. If submission times
out or is cancelled while in flight, acceptance may be unknown: do not blindly
retry a generation. Retrieve a known generation ID to check its status. Closing a
connection is not a promise that an accepted generation was cancelled, and this
server does not automatically send a generation-cancellation or refund request.

## OAuth proxy lifecycle and release verification

Token exchange and revocation responses are marked `Cache-Control: no-store` and
`Pragma: no-cache`. Their upstream requests have a ten-second deadline covering
headers and body consumption, return a sanitized 504 on timeout, and are aborted
when the caller disconnects. No exchange is automatically retried. Access-token
verification separately retains its five-second deadline.

Startup reports `registeredToolCount`, the number of available tools registered
across hosted profiles; each client's visible catalog can be smaller. Hosted API
operations are filtered once before per-session schema construction.

See [release verification](release-verification.md) for reproducible checks,
component provenance, and the distinction between controlled tests and live Muse
review readiness.


## Recovering a generation submission

`create-lipsync` accepts an optional `idempotencyKey` and forwards it as the
existing Sync API's `Idempotency-Key` header. Clients should persist a key for
one intentional generation action and reuse the same key and payload after an
ambiguous response. A new intentional generation uses a new key. The backend
owns replay, conflict detection and credit accounting; MCP does not retry writes.

Use the explicit canonical `projectId` and durable asset IDs or stable URLs for
keyed submissions. Stage ChatGPT files with `upload-media` first, then use the
returned asset IDs. Re-transferring transient file inputs can produce different
asset IDs and a changed-payload conflict. Keys accept 1-128 ASCII letters,
digits, periods, underscores, tildes and hyphens. Omitting the key preserves
existing behavior.

An `IDEMPOTENCY_OUTCOME_UNKNOWN` error may contain a UUID `generationId`.
MCP preserves that ID in `structuredContent.error`; clients should retain it
and use `generate_get-generation` for status reads instead of creating again.

## Embedded Sync app

For production, package the approved `@sync/chatgpt` build and select it in
`deploy/chatgpt/releases.json`; Docker activates that release automatically.
For local development, supply `app.html` and `manifest.json` together in
`SYNC_CHATGPT_APP_DIR`. The server verifies the
manifest format, HTML SHA256, UTF-8 and size (8 MiB maximum) at factory startup.
Each session serves those same loaded bytes under a content-addressed resource
URI. Invalid configured artifacts fail startup rather than silently serving a
different interface. These checks establish artifact consistency; deployment
must still obtain the bundle from the approved frontend build.

The `open-sync-app` tool exposes the resource through the standard MCP Apps UI
metadata and declares ChatGPT global/sidebar and thread/panel entrypoints.
Opening it is read-only. Existing uploads and tool-only clients are preserved;
the new tool and resource are only presented to the ChatGPT client profile.
HTTP authentication still applies to the MCP connection.

The resource requests camera and microphone access through MCP Apps
`ui.permissions` for user-initiated recording. The host must delegate those
permissions and the user must grant browser access. A declaration alone does
not prove capture works in ChatGPT; verify with the paired recording UI release.
Both CSP metadata formats include `blob:` for local recording review and
`data:` for static assets embedded in the verified HTML, including Studio's font.
These schemes apply to the host's static-resource policy, including scripts and
styles; this is not a font-only exception. Configured network resource and
connection origins still require exact HTTPS origins. Neither scheme is added
to connection or frame permissions.

Set the widget origin and the exact media origins for the target environment.
Browser API connections are not allowed by this UI resource's CSP; backend
operations go through the authenticated MCP bridge. The frontend remains
disabled unless its widget domain (packaged deployment) or local directory is configured. The production container
includes the pinned frontend under `/app/chatgpt-dist/<HTML SHA256>`. Docker
verifies the bundle with the same manifest loader used by the server before
copying it into the final image. See [frontend release packaging](chatgpt-release.md)
for provenance, automatic release selection, retention, and rollback. Real
ChatGPT/account acceptance remains a separate release requirement.

Local example after building the frontend and this server:

```sh
SYNC_CHATGPT_APP_DIR=/absolute/path/to/sync-api-v2/apps/chatgpt/dist \
SYNC_CHATGPT_APP_DOMAIN=https://your-verified-widget-origin.example \
SYNC_CHATGPT_APP_RESOURCE_DOMAINS='["https://your-media-origin.example"]' \
node dist/cli.js --transport http --port 3002
```

## Embedded upload and authentication behavior

The optional upload relay issues a random, single-use ticket only after an authenticated
presign request. It checks exact content type and size, expires after at most five minutes,
and streams only to the configured HTTPS storage origin under the existing upload runtime
concurrency and timeout limits. Browser relay uploads support the API single-PUT
maximum of 5 GiB; the 512 MiB download limit still applies to rehosting ChatGPT
attachments. Legacy presign responses without an expiry receive a five-minute ticket.
Tickets are process-local: the MCP session and its upload must reach the same instance.
A restart invalidates outstanding tickets; the client can request a new upload. Multi-instance
release routing must account for this before enabling the relay in production. The widget
origin must also route `/app-upload` to that instance and appear in connect domains.

OAuth verification reuses successful results for at most 15 seconds and never beyond
token expiry. Concurrent checks are deduplicated; successful revocation clears this
provider's cache. Revocation elsewhere can take up to 15 seconds to affect this cache.
Userinfo rate limits trigger token-specific backoff capped at 15 seconds, rather
than blocking unrelated accounts or treating temporary errors as invalid tokens.

Downstream tool responses with status 401 include `mcp/www_authenticate` pointing
to the same protected-resource metadata as the HTTP authentication middleware.
Tool descriptors expose `securitySchemes` and its compatibility metadata mirror.
403 permission failures and service outages do not request another sign-in.
`get-account-context` preserves verified account/workspace identity when optional
seat and voice-clone limits are unavailable; a limits 401 still requests linking.

To verify account recovery across the packaged UI and the real MCP HTTP server:

```bash
pnpm run build
node scripts/verify-account-recovery.mjs /path/to/sync-api-v2/apps/chatgpt/dist/app.html
```

Build the ChatGPT workspace first and install Playwright Chromium. The check uses
a local fixture for the Sync API and OAuth provider, exchanges a fixture code
through the actual MCP token proxy, and verifies the connected identity despite
a usage outage. It asserts that recovery makes no paid requests. Screenshots and
a browser trace are written to `temp/account-recovery/`. This proves the local
cross-service flow; the live ChatGPT consent UI still needs release acceptance.

`pnpm run test:browser` verifies an 11 MB browser upload through the real relay to fixture
storage. Install Chromium with `npx playwright install chromium` first. This does not
prove live authenticated storage delivery or authorize a production rollout.

The hosted Studio asset library uses the existing authenticated asset update,
delete and signed-download endpoints. These tools preserve upstream
permission checks and write annotations; the UI requires an explicit asset
rename or delete action and reconciles an interrupted response before offering
another write. Connected account context includes only the displayed identity,
organization and seat/voice-clone limits, with nullable identity fields preserved.
Voice cloning accepts exactly one source form: a URL, saved asset, or sample URL
list. A sample list creates one voice, not a voice per sample; uncertain clone
admission must be reconciled from the voice list without automatically resending.

The embedded continuation adapters accept an optional `continuation` object on
saved-asset lipsync, translation and dialogue generation: `{ workflow,
parentGenerationId }`. They recheck project access and the exact parent's project
membership through Studio's existing read endpoints, then forward `x-sync-workflow`
and `x-sync-parent-generation-id` headers to `/v2/generate`. Persist this context
with the approved request and key. Older saved requests without it keep their
original header set and idempotency fingerprint; do not add context on recovery.
Submission checks do not read unrelated parent media or parse its settings, so
deleting an old source does not block same-key reconciliation. The API still
authorizes the inputs of a new submission. `get-generation-continuation` retains
its full source-access checks before returning media or settings to the app.

Asset previews must use only the exact `thumbnailUrl` returned by Sync for the same
asset. The server instructions and asset discovery tools prohibit web-image
search, generated images and source-media substitutions. Missing or failed
thumbnails use `/asset-placeholder.svg`, a static black image with the Sync logo.
Hosts that cannot display it should report an unavailable thumbnail. This guidance
does not control arbitrary model prose; the embedded Studio library enforces the
thumbnail-only rule and its loading/error fallback directly.

## Availability monitoring

`pnpm run monitor:mcp` exercises authenticated initialization, tool discovery,
a read-only account call and aggregate `/status`, then deletes the probe session.
See [MCP availability](mcp-availability.md) for credential lifecycle, exit
codes, alert thresholds and rollout verification. `/health` remains liveness only.

HTTP session IDs retain only isolation metadata; SDK servers and transports close after each request. See [session lifecycle and stateless compatibility](session-lifecycle.md).

## Actual costs of past generations

When the connected Sync API supports `GET /v2/generate/:id/costs`, the server
exposes `get-generation-costs` to ChatGPT and other supported MCP clients.
Pass `{ "generationId": "<Sync generation UUID>" }`, using the ID from creation
or generation history. This is a read-only call under the connected account.

The result separates dubbing and lip-sync charges. Prepaid amounts are credits
actually consumed and their USD face value, not an allocated card payment.
Metered amounts are recorded usage charges, excluding invoice adjustments and tax.
For pending or incomplete history, `totalCostUsd` is null and
`knownSubtotalUsd` is only the known part. Unlinked speech synthesis is explicitly
unavailable, and external provider charges are excluded. The tool never estimates
or generates media to answer a past-cost question.

Deploy the API and its ID-filtered Tinybird dubbing pipe before releasing the
MCP change, then restart the MCP service so it reloads public OpenAPI capabilities.
Refresh the ChatGPT connection's tool catalog and verify in a fresh conversation.
An API without the operation does not advertise the tool.
