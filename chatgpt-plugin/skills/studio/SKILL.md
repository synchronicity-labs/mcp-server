---
name: studio
description: "Open and navigate Sync's embedded Studio, change a requested draft, display results or stage a continuation. Use only in app-capable connections, verifying that the interface applied the requested change."
license: MIT
---

# Work in embedded Studio

For “Open that project in Sync” or “Select this audio in the editor”, require an
app-capable connection and actual published Studio context. A generic Codex CLI,
Claude or other model-only client does not gain a widget by loading this skill.

Opening the app requests the interface; it does not prove rendering. Use actual
published viewId/draftId/projectId context. Never infer a “latest” widget, invent
an ID, or claim that chat prose selected media.

Before a view action, read its current revision. Submit the requested action with
that expectedRevision and a fresh UUID action ID. On an uncertain handoff, reuse
the same action ID and immutable body; do not repeat any backend creation.
Read the receipt: only applied confirms display. Pending is awaiting UI;
blocked/failed needs its reported recovery. An unavailable view must be reopened.

Draft changes use the actual editable draft and its expectedRevision. Change only
the requested selections/settings. A new visual can clear derived audio. On a
conflict, read and reconcile instead of overwriting newer edits. Only matching
appliedRevision and revision confirms Studio acknowledged the saved draft.

Opening a project, showing a generation and staging a continuation can replace
the active editor and archive its prior draft. Require deliberate user intent.
Resolve original-source versus completed-output continuation. Refresh project
details only after an actual backend change, and assets only after upload/
registration succeeded.

These operations do not synthesize, translate or render. Never repeat paid work
to refresh display. Return the actual applied/pending/blocked/failed state.
Read [the widget protocol reference](references/widget-protocol.md) for internal
registration/acknowledgement ownership; those calls are for the widget, not
model-supplied fake receipts.

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `open-sync-app`, `get-studio-view`, `get-studio-draft`, `update-studio-draft`, `open-studio-project`, `refresh-studio-project`, `refresh-studio-assets`, `show-studio-generation`, `continue-studio-generation` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
