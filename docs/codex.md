# Codex notes

Codex connects to the hosted server with `codex mcp add sync --url https://mcp.sync.so/mcp`
(see the README). It gets the ChatGPT app's tools through the same connector, under the
`openai-mcp (Codex)` profile in `src/client-profile.ts`.

## "MCP tool call requires approval, but approval policy is never"

Codex refuses every sync. tool call with this message when it runs without approval
prompts, for example in `codex exec` or with an approval policy of `never`, and nothing
allows this server's tools. Allow them in `~/.codex/config.toml`, inside the server's
existing section so it keeps its `url`:

```toml
[mcp_servers.sync]
url = "https://mcp.sync.so/mcp"
default_tools_approval_mode = "approve"
```

A section with only `default_tools_approval_mode` and no `url` makes Codex reject the
config. To allow one tool instead, set `approval_mode` under
`[mcp_servers.sync.tools.<tool>]`. Both keys are in the
[Codex configuration reference](https://developers.openai.com/codex/config-reference).

## Local files and results

Through the hosted server, Codex can't pass a local file to `assets_upload`: that tool
takes only a file object the host provides, and Codex fails it with "no primary turn
environment". The agent uploads a local file in two steps instead:
`assets_create-upload-url`, then a `PUT` of the bytes from the shell, then
`assets_create`. It saves a result by downloading its `outputMediaUrl`. Both need
network access in Codex's sandbox.

Without network access, upload the file in sync. Studio at [sync.so](https://sync.so)
and ask the agent to use it (it finds it with `assets_list`), and open the result's link
yourself.

The local server (`npx @sync.so/mcp-server` with `SYNC_API_KEY`) works the same way. It
doesn't read local file paths either, so it doesn't avoid the `PUT`.

The tool descriptions tell the agent the same: `assets_upload` and `generations_get` carry
a note for the Codex profile only, and `assets_create-upload-url` and the model-only
`lipsync_create` say to ask for an upload in sync. Studio when the agent can't send the
`PUT`.
