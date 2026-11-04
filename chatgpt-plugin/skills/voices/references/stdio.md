# Local stdio voice management

| Operation | Tool |
| --- | --- |
| Inspect one voice | `voices_get-voice` |
| Delete a saved voice | `voices_delete-voice` |

Discover the exact tools and schemas. Inspect a matched Sync voice ID before
changing it. Deletion requires the user's explicit request and an unambiguous
confirmed target under the tool/host policy. Do not delete a premade/provider
voice or another organization's voice to clear a slot. Return actual deletion
receipt or error. A timeout requires read/list reconciliation, not automatic
repetition. Selection, inspection and deletion do not authorize a new voice clone.
