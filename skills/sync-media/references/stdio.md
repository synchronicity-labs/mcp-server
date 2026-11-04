# Local stdio asset lookup

| Operation | Tool |
| --- | --- |
| Read several assets by ID | `assets_get-many` |

Use actual requested asset IDs and the schema's batch limit. Missing/inaccessible
members stay missing; do not infer they were deleted or replace them with another
asset. This is batch lookup, not the filtered-out native batch generation API.
Other media operations use the curated asset tools exposed by this connection.
