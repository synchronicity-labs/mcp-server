---
name: create-video
description: Create lipsync videos or translate saved videos with Sync, using its MCP tools to select media, estimate cost, submit, and retrieve results.
---

Use the connected Sync MCP server. If authentication is needed, direct the user
to Claude Code's `/mcp` authentication flow. Never ask them to paste credentials
into the conversation. Available workflows are defined by the discovered tools.

Choose a project returned by `projects_get-all`, or create one when requested.
Asset IDs must belong to the connected Sync organization. Confirm the intended
organization when it is unclear; a similarly named project is not proof of it.

`create-lipsync` takes one image or video and one audio input or script. For a
script, select a real voice from `voices_get-voices`. Use existing asset IDs or
public/Sync-hosted URLs. For a local file, use `assets_create-upload-url`, upload
its bytes with the requested Content-Type, then register the returned media URL
with `assets_create`. Do not send a local filesystem path as a public URL or
assume Claude chat attachments implement the OpenAI file bridge.

Before a paid action, obtain `generate_estimate-cost` for the selected model,
settings and duration. Show its returned unit and assumptions. For translation,
use `workflow=translate-and-dub` when supported and require its combined cost
breakdown; disclose excluded external charges. A lipsync-only quote is not a
translation quote. Respect the user's existing budget and configuration approval;
ask only when these are missing or the proposed action exceeds them.

For each intentional generation, use one UUID idempotencyKey when the tool
supports it. Keep the exact key and frozen inputs available before submission.
On a timeout or lost response, recover with that same key and inputs; never
silently replace the key. If recovery details are lost or the recovery window
expires, inspect project history and ask the user to resolve the ambiguous
attempt before another paid submission. An error does not prove no job exists.

For translation, submit one `create-translate-and-dub` request against a saved
video. Do not create independent paid translation stages. After acceptance,
poll `generate_get-generation` using the returned generation ID with `wait: true`.
Polling never creates another job. Return the exact outputUrl, preserving signed
query parameters, and the generation ID. If a link expires, refresh the existing
generation rather than generating again. Use project history for continuity.
