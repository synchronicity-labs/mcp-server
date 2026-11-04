# Raw stdio request construction

| Operation | Tool |
| --- | --- |
| Create raw generation | `generate_create-generation` |
| Discover models | `models_get` |
| Estimate and track | `generate_estimate-cost`, `generate_get-generation` |

Inspect live schemas and model features before constructing the request.
Do not infer eligibility from a stale example or enum. Model names, including
historically misspelled ones, are returned identifiers; do not “correct” them.

- Standard lip sync uses exactly one visual plus one audio/text performance.
  Prefer the curated creator when these are the only requirements.
- Multi-segment requests reference unique audio/text refIds from segments.
  Respect timing units, clip limits, overlaps, kept ranges and outputAudio
  restrictions advertised by this API/model.
- Shared-timeline multi-speaker requests need an enabled eligible model,
  actual face/audio mappings and matching durations. Do not combine incompatible
  segments, dubbing, sync_mode or global speaker settings.
- Appearance/model-specific generation uses only supported inputs/options,
  such as requested prompt/reference images when actually accepted. Do not
  invent an appearance-preview tool or turn a lip-sync model into another type.
- Dialogue/reviewed-dub references must already exist and be eligible. The raw
  generator cannot create reviewed-dubbing drafts or analyses through filtered
  APIs. Prefer dedicated workflow wrappers for dialogue/translation.
- Output filenames, buckets, formats, retention-related options and callbacks
  are separate capabilities; do not assume all combinations work. Use supported
  fields and tell the user about rejected combinations before a changed job.

Confirm sources/configuration and costs, disclosing excluded charges. Persist
idempotencyKey and immutable inputs. A tool without a way to forward the API's
admission header cannot be treated as safely replayable. Never put credentials
or arbitrary headers into generation JSON.

A user-provided existing callback URL is not a deployed webhook receiver. MCP
does not expose signing-secret retrieval through its current parser; use secure
external setup for signature verification and do not claim it occurred here.
Native batch, analysis and reviewed-dub administration are also filtered out.
Several approved jobs can be coordinated through normal generation requests
with separate keys and bounded concurrency; report each outcome independently.
