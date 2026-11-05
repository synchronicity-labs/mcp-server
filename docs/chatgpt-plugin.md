# ChatGPT plugin package

The plugin package is uploaded to the OpenAI publisher for plugin
`plugin_asdk_app_6a398355fbc08191a232e7eeeacb73d5`, and Codex installs the same
package. It holds what only a new package version can change:

- the listing: name, descriptions, keywords, category, capabilities and the
  three starter prompts in `chatgpt-plugin/.codex-plugin/plugin.json`
- the MCP server address in `chatgpt-plugin/.mcp.json`
- the logo in `chatgpt-plugin/assets/`
- the skills, which come from
  [synchronicity-labs/skills](https://github.com/synchronicity-labs/skills)

Tools and server instructions are not in the package. ChatGPT reads them from
the live server when OpenAI scans it.

## Skills

The skills live in the public skills repository, which also ships them to
skills.sh, Claude Code, Cursor and Codex. Edit them there, never here: this
repository holds no `SKILL.md` content. `chatgpt-plugin/skills.source.json`
says what the package takes from it:

- **`repository` and `commit`**: the exact skills commit to package, as a full SHA.
- **`skills`**: the skills the package ships, in listing order. A `policy` is
  appended to that skill's `agents/openai.yaml`; `setup` sets
  `allow_implicit_invocation: false` so it runs only when the user asks.
- **`excluded`**: skills in the repository that the package leaves out, each
  with the reason. Every skill at the pinned commit must be shipped or
  excluded, so a new upstream skill is a decision, not an accident.

`pnpm run package:plugin` fetches that commit (no credentials; the repository
is public), copies each listed `skills/<name>/` folder whole, including
`references/`, `scripts/` and `agents/`, and writes the package to
`chatgpt-plugin-dist/`. It fails when the fetched commit differs from the pin,
a listed skill is missing, a skill's frontmatter name differs from its folder,
a skill links to a file it doesn't contain, an upstream skill is neither
shipped nor excluded, or the manifest's onboarding skill
(`extensions.com.openai.onboardingSkill`, `setup`) isn't packaged. The same pin
always produces the same bytes; the script prints the file count and a digest.

After `pnpm run build`, `pnpm run verify:plugin` fails when a packaged skill
names a tool that isn't in `HOSTED_HTTP_TOOL_ALLOWLIST`, so rename a tool in the
skills repository before or with the server change. CI runs both steps on every
pull request.

Skill names are the skills repository's. A plugin version that renames a skill
(2.1.0 packages `lipsync`, where 2.0.4 had `lipsync-video`) changes what users
type to call it directly (`@` in ChatGPT, `$` in Codex); the plugin name, which
namespaces its skills, stays the same.

### Update the skills

```bash
pnpm run skills:update          # pin the skills repository's current main
pnpm run skills:update --commit <sha>
```

This rewrites `commit` in `skills.source.json`, lists skills added or removed
upstream, and packages the new pin. If it reports a new skill, add it to
`skills` or `excluded` and run `pnpm run package:plugin`. Open a pull request
with the bump; it does not change the server, but the package only reaches
users through a new plugin version (below).

## Release a version

1. **Bump and build.** Bump `version` in `chatgpt-plugin/.codex-plugin/plugin.json`,
   then build the upload with `pnpm run package:plugin` and
   `cd chatgpt-plugin-dist && zip -r -X ../chatgpt-plugin-<version>.zip . -x '*.DS_Store'`.
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
