# Agent payments

An agent with a payment wallet can pay for a plan or credits itself, without a person
opening a browser. An agent without one creates an approval link instead
(`billing-approval-links_create`, see [tool workflows](tool-workflows.md)).

## The tool

`billing-payment-links_create` (`POST /v2/billing/payment-links`) takes exactly one of
`plan` or `credits` and returns a `url` the wallet pays, with the price
(`amountCents`, `currency`, `interval`), `networkId`, `expiresAt` and the organization.
Creating a link charges nothing and stores nothing. The link works for an hour.

The wallet pays by sending a POST to the `url`. That request carries no sync. credential:
the signed link names the organization and the purchase. The API answers 402 with a
Machine Payments Protocol challenge (Stripe `charge`, card shared payment token) and,
once paid, 200 with a `Payment-Receipt`. Credits take a one-time token. A plan takes a
recurring monthly token, which also pays each renewal until the person revokes it.

The server never sees a payment token and never makes the paying request. It only hands
the agent the link.

## Why a link and not a token input

Stripe's Link CLI, the wallet coding agents have today, does not give the agent a raw
token. It calls the seller's URL itself (`link-cli mpp pay <url> --method POST`). A tool
that took a token could not be used with it, and a wallet command that carried the
agent's sync. sign-in would put that sign-in in front of the model.

## Who sees the tool

- Only accounts whose `GET /v2/account` `features` lists `agent_payments`
  (`src/account-features.ts`). The API lists it where its deployment takes agent
  payments, which is the same check behind the purchase routes' 403
  `machine_payments_unavailable`.
- Only the generic client profile, which is how coding agents connect (Claude Code,
  Cursor, Codex CLI, the local server). `paysInClient` in
  `src/tools/billing-payment-links.ts` keeps it out of the ChatGPT app, Codex through the
  OpenAI connector, and Claude.ai, and refuses a direct call from them: app directories
  keep purchases out of their apps, and those clients have no wallet to pay with.
- Locally, the `default` and `all` toolsets. A narrower toolset leaves it out, so it
  never adds an account read to a server that lists no other gated tool.
- The server instructions do not mention it, so no client's instructions changed. The
  tool description carries the guidance.

## Plans and prices

`billing-plans_list` (`GET /v2/billing/plans`) lists what the organization can buy, with
each price, so a person chooses in the chat instead of on the website. It only reads. It
is listed wherever approval links are, which is every client but the ChatGPT app, and
takes the same one-call `organizationId`. An API from before the route answers 404, and
the tool then says to quote one plan with `billing-approval-links_create`.

## The guide a coding agent gets

[AGENT_GUIDE.md](../AGENT_GUIDE.md) ships in the npm package. `setup --code` prints it
last, after it has added the server and the sync. skills
(`npx skills add synchronicity-labs/skills`) to the agent, and `sync-mcp guide` prints it
again. It tells the agent what to say to the person straight away (start a new session,
what they can ask for, what the Free plan gives them, that they can pay from the chat)
and how plans and paying work afterwards.

It is a file here and not a skill on purpose. The skills are shared with the ChatGPT app,
which must not promote plans. The guide reaches only an agent that ran `setup` in a
terminal.
