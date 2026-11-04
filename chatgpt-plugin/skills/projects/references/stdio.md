# Local stdio project operations

| Operation | Tool |
| --- | --- |
| Attach/detach saved media | `projects_attach-asset`, `projects_detach-asset` |
| Change supported properties | `projects_update` |
| Delete a project | `projects_delete` |

Discover the live schema. Prefer canonical projectId over an old id alias.
Use the selected existing project and exact saved asset for attachment changes.
Detachment does not mean deletion. Modify only user-requested fields.
Prefer the dedicated rename tool for a name-only change. Confirm a destructive
target/action when required and respect returned access checks; visibility is
not write permission. Do not switch identities or change visibility to bypass
a failure. Reconcile uncertain writes through project/media reads. Return the
actual affected IDs and receipt; do not promise cascading asset/job deletion
unless the API explicitly documents and confirms it.
