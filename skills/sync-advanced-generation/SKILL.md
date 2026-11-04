---
name: sync-advanced-generation
description: "Use Sync's local stdio raw generation tools for supported multi-speaker or model-specific requests, including eligible appearance editing, output configuration or callbacks. Use when a curated video workflow cannot express the requested configuration."
license: MIT
---

# Submit an advanced stdio generation

For “Use these speakers on one shared timeline” or “Run this supported appearance
model with my references”, require a stdio connection exposing the raw generation
tool. Hosted clients do not expose it. Discover the actual model/features and
request schema; examples and old enum members do not establish eligibility.

Read [the stdio request reference](references/stdio.md) before constructing a
request. Prefer a curated workflow when it expresses the user's intent. Resolve
all source assets, speakers, references, timing and project deliberately. Do not
combine mutually exclusive segments, dubbing, dialogue, speakers and global
selection merely because the JSON schema lists each field.

Quote the requested model and actual output configuration. Disclose any missing
provider or model-specific pricing and obtain applicable spending authorization.
Preserve approved inputs and idempotencyKey before creation; use only an exposed
field that the MCP actually forwards as the required admission header. A key
inside arbitrary JSON is not proof of deduplication.

Submit once and track its returned generation ID. On uncertain admission, use
that ID or the original same-key request only under the server contract. Never
switch keys or models as an automatic retry. Return exact output URL, state and
any rejected configuration that needs user correction.

For several requested outputs, keep a separate request identity per approved job,
respect available concurrency and the user's total budget, and report each job.
Do not pretend a native batch endpoint exists. An existing webhook URL can be
passed only when requested and supported; this does not provision a receiver or
retrieve its signing secret through MCP.

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `models_get`, `generate_create-generation`, `generate_estimate-cost`, `generate_get-generation`, `assets_get`, `projects_create` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
