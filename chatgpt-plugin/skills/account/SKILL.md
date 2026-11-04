---
name: account
description: "Inspect Sync account/workspace identity, usage, available credits, limits and models, or estimate and explain generation costs. Use for billing questions; these tools do not purchase credits or change plans."
license: MIT
---

# Explain account context and costs

For “How many credits remain?” read the connected organization's context and usage.
Report only returned values. API keys have no signed-in user; visibility,
membership and permission do not come from a guessed email or client name.
A different browser login does not change the connected workspace.

Explain concurrency/duration, seats, voice slots and allowances when available.
Missing usage stays unavailable, not zero. Available credits can exclude holds.
These reads do not buy credits, change billing plans, rotate keys or switch
organizations. Direct the user to the returned billing link for unsupported
account changes instead of claiming they happened.

For an estimate, discover an eligible model and the actual workflow configuration.
Replacement speech uses measured audioDuration or an approximate script estimate,
not the full source video duration. Include videoDuration/syncMode when duration
handling requires them and visualType=image for an image. Quote combined dubbing
only when supported; otherwise disclose missing stages/provider charges.
An estimate does not reserve credits or submit work.

For “What did my last video cost?”, resolve its generation through history and
read actual recorded costs. Show lip sync and dubbing components separately,
known subtotal versus unknown total, and credit face value versus money paid.
Never replace an unavailable actual cost with an estimate or another paid run.

Return the identity/usage/quote/cost with its basis and uncertainties. Estimates
can be used by another workflow only under the applicable spending authorization.
For the extra stdio estimate alias, read
[the stdio reference](references/stdio.md).

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `get-account-context`, `get-account-usage`, `models_get`, `generate_estimate-cost`, `get-generation-costs`, `generate_get-generations` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
