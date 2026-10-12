# Hosted voice-cloning acceptance

CRAFT-6568 adds `voices_clone-voice` to the hosted catalog when the API exposes
the operation. The existing generated API schema and request-scoped OAuth client
remain in use. The API remains authoritative for access, plan and sample checks.
There is no new frontend bundle or voice-cloning form in this change.

The live API schema was read without authentication or writes on October 8,
2026 (EDT). It exposes `POST /v2/voices` with `name`, `provider: elevenlabs`, and
an `allOf/oneOf` choice of `url` or `assetId`. The generic converter incorrectly
made both alternatives required. The clone-specific descriptor now leaves the
alternatives optional individually and the handler validates exactly one valid
URL or UUID before sending a request. Tests use that observed composed schema.

## Verification layers

- MCP fixture tests: initialize as `openai-mcp`, discover cloning, submit one
  sample, return structured IDs, list the clone and use the Sync ID in a script
  generation. Verify request auth/source, API errors, no automatic retries,
  unavailable API behavior, and that deletion remains hidden.
- These use a local fixture API. They do not prove voice similarity, provider
  availability, real billing, or published ChatGPT tool availability.
- Before release, connect the candidate through a private ChatGPT connector,
  verify the schema and confirmation flow, and inspect available voices.
- A real clone requires explicit approval for one provider-backed attempt with
  a sample the user owns or has permission to clone. Record sample duration,
  account plan, result ID and the observed outcome without exposing credentials.
- Reuse the returned Sync `id` in one separately approved estimated video
  generation. Listen to the output, inspect video playback and verify the voice
  appears in the normal Sync voice list. Do not substitute the provider's
  `voiceId` for the Sync ID.
- Verify plan-limit, invalid/too-short/no-audio sample, inaccessible asset,
  duplicate-name and rate-limit messages using controlled fixtures; do not
  exhaust real clone slots merely to provoke errors.

## Failure handling and release

Clone requests are non-idempotent. If a response is lost, list voices and ask
the user to verify the result before another attempt. Do not retry blindly or
claim an unknown outcome failed without creating a voice. A successful clone
does not authorize subsequent paid synthesis or video generation.

After the reviewed deployment, rescan the existing publisher connection and
verify `voices_clone-voice` is approved/live in a fresh ChatGPT conversation.
Record any review hold separately from server deployment status. Keep CRAFT-6568
open until the provider-backed and published-plugin checks are complete.

## Recorded private acceptance

On October 8, 2026 at 21:37 EDT, the private Sync Dev ChatGPT connector
successfully created an ElevenLabs-backed reusable clone from Noah's approved
13.76-second video. The test confirmed sample/name/voice rights and checked for
an existing exact-name clone before creation. A subsequent `voices_get-voices`
response returned the saved clone with matching Sync and provider identifiers.
The task's `discovery-voice-acceptance/voice-clone-tools.txt` capture preserves
the tool response. Clone creation and persistence are verified; this test does
not need repeating just because the earlier PR description omitted it.

Audio synthesis and video generation with this clone were not performed, so
voice quality and published production-tool acceptance remain unverified.
The later merge preparation incorporates main's workflow-boundary instructions
and shared-schema memory protection without changing the clone contract.
