# Local stdio generation management

| Operation | Tool |
| --- | --- |
| Count matching jobs | `generations_get-count` |
| Direct job read | `generations_get-by-id` |
| Download result | `generations_get-download-url` |
| Rename output | `generations_update-output-file-name` |
| Delete saved generation | `generations_delete` |

Prefer the canonical status workflow when it covers the request; use these
operations only when actually exposed. Count filters must match the requested
history scope. Resolve the exact generation before a name/deletion change.
Follow filename constraints and return the accepted filename, not a guessed one.
Deletion requires explicit confirmed intent and is not cancellation of an
in-flight render. An expired signed URL is recovered from the same job, not by
rendering again. Respect entitlement/permission failures and do not claim a
downloadable result when it is unavailable.
