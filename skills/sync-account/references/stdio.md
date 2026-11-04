# Local stdio estimate alias

| Operation | Tool |
| --- | --- |
| Additional generation estimate route | `generations_estimate-cost` |

Prefer `generate_estimate-cost` when available. This additional operation is an
estimate, not recorded spending or credit reservation. Use its own schema,
supported model/configuration and units. Do not add two alternative estimates
together. Missing billing components remain unknown. It does not purchase
credits, change plans, or access a webhook signing secret.
