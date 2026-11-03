# ChatGPT plugin package

`chatgpt-plugin/` is the package uploaded to the OpenAI publisher for plugin
`plugin_asdk_app_6a398355fbc08191a232e7eeeacb73d5`. It holds what only a new
package version can change:

- the listing: name, descriptions, keywords, category, capabilities and the
  three starter prompts in `.codex-plugin/plugin.json`
- the MCP server address in `.mcp.json`
- the logo in `assets/`
- the skills in `skills/`

Tools and server instructions are not in the package. ChatGPT reads them from
the live server when OpenAI scans it.

## Skills

Each skill is one workflow: `skills/<name>/SKILL.md` and
`skills/<name>/agents/openai.yaml`.

- **`SKILL.md`** starts with `name` and `description`. ChatGPT reads only these
  until a request matches, then loads the steps.
- **`agents/openai.yaml`** sets the display name, short description and starter
  prompt. `policy.allow_implicit_invocation: false` keeps `setup` from running
  unless the user asks for it.

`setup` is also the onboarding skill (`extensions.com.openai.onboardingSkill`),
which ChatGPT runs when a user sets the plugin up after installing it.

Name tools in each skill's Tools table exactly as the hosted server lists them.
`src/chatgpt-plugin.test.ts` fails when a skill names a tool that isn't in
`HOSTED_HTTP_TOOL_ALLOWLIST`, so rename skills' tools in the same change as the
server.

## Release a version

1. **Bump and build.** Bump `version` in `.codex-plugin/plugin.json`, then build
   the upload with `cd chatgpt-plugin && zip -r -X ../chatgpt-plugin-<version>.zip . -x '*.DS_Store'`.
2. **Upload and check.** In the publisher, open the plugin and upload the ZIP as
   a new version under **Metadata & Skills**. Run the preflight checks.
3. **Submit.** Submit with the same attestations as the previous version.
   Review has taken 6 hours or less.
4. **Publish.** Publish once it's approved. There's no documented rollback; fix
   forward with a new version.
5. **Verify.** On the plugin page, check the version, category and skills. Run
   directory searches for the main keywords, and try the prompts in
   `chatgpt-discovery-prompts.csv` in a new chat.

## After a deploy that changes tools

Open the publisher's **MCPs** tab, select **Rescan**, and confirm the changed
tools show as live with no findings. Then check a new chat, because ChatGPT can
keep serving the previous definitions for a while. The server must keep
accepting calls shaped by the previous schema until then (see `AGENTS.md`).
