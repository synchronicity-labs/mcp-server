---
name: sync-projects
description: "Create, find, inspect, rename or organize Sync projects and their media/history. Use for project management, with additional property, attachment and deletion operations on capable stdio clients."
license: MIT
---

# Manage projects

For “Find my product launch project and rename it”, resolve the selected account
and the specific existing project. Search small pages with the user's terms,
show ambiguous matches, and use the returned ID. A workflow label or matching
name is not authorization to select or modify a project.

New workflow requests get a new project by default, even if its name matches
existing work. Persist a fresh UUID for project creation and reuse it only to
reconcile the identical creation. An existing project is used only when explicitly
selected. Pass projectIntent when required by the tool.

Read details and generation history without changing the active Studio view.
History cursors are returned IDs, not invented offsets. Rename only on an explicit
request and preserve all other properties. A successful backend rename is not
proof that an already mounted Studio has refreshed.

Additional stdio operations attach/detach an existing media asset, update supported
project fields or delete a project. Read [the stdio reference](references/stdio.md)
before those operations. Resolve the exact project/asset, requested fields,
permissions and destructive confirmation. Detaching media is not deleting it;
do not infer deletion consequences absent the API contract.

Return the project ID, actual result and affected assets. On a permission error,
stop and explain the cause. On an uncertain write, reconcile through a read
before another write. Project management never authorizes paid generation or
replacing the user's unsaved Studio draft.

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `projects_get-all`, `projects_get`, `projects_create`, `projects_get-generations`, `rename-project`, `get-account-context` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
