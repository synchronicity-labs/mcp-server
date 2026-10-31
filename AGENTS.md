# AGENTS.md

Guide for coding agents working in this repository. `CLAUDE.md` links here.

## What this is

sync.'s MCP server. It runs two ways from the same code:

- **Hosted** at `https://mcp.sync.so/mcp`: Streamable HTTP, OAuth proxied to `api.sync.so`, one Porter replica. ChatGPT, Claude.ai, Claude Code, Cursor and Codex connect here.
- **stdio** through `npx @sync.so/mcp-server` with `SYNC_API_KEY`, for local clients.

Every merge to `main` deploys production. Treat each merge as a release.

## Where things live

| Path | Owns |
| --- | --- |
| `src/server.ts` | Tool assembly, `HOSTED_HTTP_TOOL_ALLOWLIST`, per-profile visibility (`isAppOnlyTool`), instructions (`INSTRUCTION_PARTS`), `tools/list` descriptors |
| `src/client-profile.ts` | Maps the handshake client name to a presentation profile (chatgpt, codex, claude, generic). Presentation only, never permissions |
| `src/tools/` | Hand-written tools; `generator.ts` turns public OpenAPI operations into generated tools |
| `src/openapi/` | Fetches and parses `api.sync.so/api-json` at startup |
| `src/http-server.ts`, `src/http-session.ts`, `src/session-registry.ts` | Express app, OAuth proxy routes, `/mcp`, `/health`, request-scoped MCP sessions |
| `src/rate-limits.ts` | Request limits per verified user and OAuth client, plus per-address limits on rejected credentials |
| `src/auth/` | OAuth proxy provider (SDK `server-legacy`), bearer verification, device auth for stdio |
| `src/chatgpt-app.ts`, `deploy/chatgpt/` | Immutable ChatGPT UI releases built from sync-api-v2 `apps/chatgpt`; see `docs/chatgpt-release.md` |
| `scripts/` | Memory and session suites, UI packaging, monitor, post-deploy smoke check, pre-commit size check |
| `docs/` | Maintainer notes (`docs/maintainers.md`), release, availability and auth details |

## Commands

```bash
pnpm install              # also installs the pre-commit hook
pnpm run lint             # type-aware Oxlint, then oxfmt --check
pnpm run knip             # unused files, exports and dependencies, then import cycles
pnpm run typecheck
pnpm run build
pnpm test                 # vitest; use --no-file-parallelism on a loaded machine
pnpm run test:scripts     # node:test suites under scripts/
pnpm run test:memory      # session memory; add --burst for the burst scenario
pnpm run test:memory:http
pnpm run package:chatgpt && pnpm run verify:chatgpt-package
```

`test:browser` needs the Playwright container that CI uses; it fails on a plain
macOS shell. Type-aware lint resolves `scripts/` types through `dist/`, and CI
lints before building, so lint once with `dist/` absent before pushing.

Use the Node major in `.nvmrc`; pnpm refuses to install on Node older than
22.22.1. The pre-commit hook runs Oxlint and an oxfmt check on staged files,
then rejects any staged file over 20 KB (about 5,000 tokens) unless it was
already that large at `HEAD`. Lockfiles, snapshots, generated files and
`deploy/` are exempt.

## Invariants

- **Tool names, schemas and `_meta` are a published contract.** OpenAI rescans the ChatGPT app on every deploy. Keep ChatGPT and Codex descriptors byte-identical unless the change is intended. Say so in the PR when they move.
- **Never change the OAuth issuer `https://mcp.sync.so/` or `/authorize`, `/token`, `/register`, `/revoke`.** Changing any of them forces every connected user to reconnect.
- **Generated tool names come from API operationIds.** Renaming a controller method in sync-api-v2 silently drops a hosted tool unless `HOSTED_HTTP_TOOL_ALLOWLIST` follows.
- **App-only tools stay out of model-only clients.** Studio bridge tools and widget-only tools (`ui.visibility` without `model`) are hidden, and refuse direct calls, outside the ChatGPT app.
- **Limit requests by verified user or OAuth client, never by address alone.** ChatGPT and Claude.ai reach the server from a few shared egress addresses, so an address limit throttles all of their users together. Address limits count only rejected credentials.
- **Sessions, upload tickets and token caches live in one process.** Do not add replicas without cross-pod routing.
- **Keep `undici` on the same major as Node's bundled undici.** The upload path hands an undici dispatcher to Node's built-in `fetch`.
- **Fix lint findings rather than disabling them.** Unused disable directives fail lint. The ten files with complexity caps in `.oxlintrc.json` must not grow; split them instead.

## Verifying a change

1. Run the commands above that your change touches.
2. For anything that can change what clients see, capture the wire before and after. After `pnpm run build && pnpm run package:chatgpt`, run `pnpm run capture:wire capture --out before.json --spec api-json.json` on `main`, the same with `--out after.json` on your branch, then `pnpm run capture:wire diff before.json after.json`. Against a local stub API, a capture records, over HTTP, protocol negotiation, the OAuth documents and 401 challenge, and `initialize`, `tools/list`, resources, resource templates, prompts and an unknown-tool call for each client name. Over stdio it records only `initialize` and `tools/list`, for `claude-code` and `openai-mcp`. Pass the same `--spec` file to both; without it the script fetches `api.sync.so/api-json` into `.cache/`, which `pnpm run clean` deletes. Report the diff in the PR.
3. After a merge, the deploy job's smoke step must pass: `/health` reports the merged `revision`, and the OAuth documents and the 401 challenge are unchanged.

## Pull requests

- Branch from `origin/main` and open a non-draft PR. Name the Linear issue in the body (`Linear: CRAFT-1234`).
- Greptile reviews on open. Later pushes need an `@greptileai` comment. Merging needs Greptile's approval (5/5), green `verify` and `packaged-image`, and no open threads.
- Reply to each review thread with what changed, then resolve it.
