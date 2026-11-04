---
name: setup
description: "Connect an agent to Sync, verify its account and available MCP workflows, and install or update Sync skills. Use for first-time setup or a missing Sync connection."
license: MIT
---

# Connect to Sync

For “Set up Sync in my agent”, help the user establish a working connection and
identify what it can do. Installation alone does not grant account access.

1. Prefer the hosted OAuth endpoint `https://mcp.sync.so/mcp`. In Claude Code:
   `claude mcp add --transport http sync https://mcp.sync.so/mcp`, then use
   `/mcp` to sign in. In Codex:
   `codex mcp add sync --url https://mcp.sync.so/mcp`, then
   `codex mcp login sync`. Other hosts use their remote MCP/OAuth connection UI.
2. For a client needing stdio, use the published `@sync.so/mcp-server` package.
   Follow its [setup guide](https://github.com/synchronicity-labs/mcp-server#connect-your-agent).
   Keep keys in client credential storage/configured environment, not chat or git.
   npm and hosted releases can expose different catalogs.
3. Discover actual tools and their schemas. Read account context to identify the
   connected organization and permissions; an API key has no signed-in user.
   Resolve an ambiguous account before writes. Another browser login does not
   change this MCP connection's organization.
4. Explain available workflows, usage/limits if requested, and missing capabilities.
   A generic CLI is not automatically an app-capable Codex/ChatGPT connection.
   Studio widgets require the host's app bridge. Local files without that bridge
   need presigned upload and a host capable of sending bytes.
5. For skill installation, copy whole selected `skills/sync-*/` folders from a
   reviewed MCP repository revision into the host's skill location. Claude Code
   uses `~/.claude/skills`; Codex uses `~/.agents/skills`. Repository scope uses
   the corresponding directory inside the user's project. Refresh discovery
   and verify the skill appears; do not overwrite unrelated skills silently.

Report the verified connection, organization and supported next action. Do not
start a “first video” as a side effect of setup. For updates, review a newer source
revision and replace only selected skill folders. Removing skills does not
delete Sync data or disconnect the MCP server. On auth errors, use the client's
reconnect flow; never request a token pasted in chat.

## Tools

| Step | Tool |
| --- | --- |
| Available operations | `get-account-context`, `get-account-usage`, `models_get` |

## Tool and account boundaries

Discover actual tool schemas and host prefixes. Resolve the intended account before
writes, preserve existing authorization within scope, and follow stricter tool
contracts. Missing tools require a clear supported alternative, not guessed API
calls. Keep credentials and signed media links out of git and public evidence.
