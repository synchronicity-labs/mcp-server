# Official Sync skills

Portable workflow instructions for using Sync through an MCP-connected agent.
The complete release contains sixteen independently installable skills:

| Skill | Use it for |
| --- | --- |
| `sync-setup` | Configure hosted OAuth or local stdio, verify available tools and account, install/update/remove skills. |
| `sync-lipsync` | Video plus audio/script; speaker selection, duration modes, valid models, estimate and completed result. |
| `sync-talking-photo` | Image plus speech/script, voice selection, supported image animation settings and output. |
| `sync-edit-dialogue` | Timed word corrections/removals, original-voice permission, preview, partial edits and final video. |
| `sync-translate-and-dub` | Combined dubbed video or separately approved translated-audio preview followed by lip sync. |
| `sync-timeline-lipsync` | Multiple clips, timing, per-clip speakers, kept ranges and output audio where supported. |
| `sync-speech` | Script/voice speech previews, job recovery and saving/reusing audio; raw TTS only where exposed. |
| `sync-voices` | Find/select voices, explicitly clone permitted samples, inspect/delete voices where exposed. |
| `sync-media` | Upload/register/import, browse/filter/count, metadata/download, rename/share/delete, prefix audio trim. |
| `sync-projects` | Create/find/read/rename projects; attach/detach media, change supported properties/delete under stdio. |
| `sync-generations` | History/count/status, exact output/download, source/output continuation; rename/delete under stdio. |
| `sync-account` | Account/workspace context, usage/allowance/limits, model discovery, estimates and actual cost breakdowns. |
| `sync-studio` | Open/navigate/configure drafts, display results and continue work with applied-receipt verification. |
| `sync-transcribe` | Standalone audio/video timed transcription under stdio; hosted saved-video transcription within dialogue-tool limits. |
| `sync-advanced-generation` | Raw stdio generation: supported multi-speaker/model-specific requests, output settings and existing webhook callback; coordinate multiple jobs. |
| `sync-troubleshoot` | Diagnose auth/input/billing/provider/job errors, resume known work, and submit explicitly authorized feedback where exposed. |

These portable skills live under the top-level `skills/` directory of Sync's
MCP repository and use its MIT license. Installing them does not require building
or running the MCP server. The hosted connection handles execution.

Clone a reviewed repository revision before installing:

```bash
git clone https://github.com/synchronicity-labs/mcp-server.git
cd mcp-server
git rev-parse HEAD
```

Record that revision when sharing feedback. For a pending PR, check out its
reviewed branch explicitly; the default branch contains only merged releases.

## Connect Sync

You need a Sync account, access to the chosen workflow, and sufficient credits
for paid actions. The skills provide instructions; the MCP connection provides
tools and account access. A text-only model cannot run them on its own.

Prefer the hosted server with OAuth: `https://mcp.sync.so/mcp`.

For Claude Code:

```bash
claude mcp add --transport http sync https://mcp.sync.so/mcp
```

Open `/mcp`, select Sync, and sign in. For Codex:

```bash
codex mcp add sync --url https://mcp.sync.so/mcp
codex mcp login sync
```

Other clients need remote MCP over Streamable HTTP with OAuth. Follow their
connection UI using the same endpoint. For clients that need a local server,
see [official MCP setup](https://github.com/synchronicity-labs/mcp-server#connect-your-agent).
Its npm release may expose different capabilities from the hosted version.
Keep credentials in the client's credential storage or configured environment.

## Install the skills

From the repository root, install the full skill folders into the client's local
skill directory. These examples use personal scope. Review any overwrite prompt
if an earlier copy already exists.

Claude Code:

```bash
mkdir -p "$HOME/.claude/skills"
for sync_skill_dir in skills/*/; do
  cp -Ri "$sync_skill_dir" "$HOME/.claude/skills/"
done
```

Codex:

```bash
mkdir -p "$HOME/.agents/skills"
for sync_skill_dir in skills/*/; do
  cp -Ri "$sync_skill_dir" "$HOME/.agents/skills/"
done
```

These commands install all sixteen skill folders. To install one skill, copy
just its folder instead of using the loop.

For project scope, use `.claude/skills/` or `.agents/skills/` in the target
project. Reopen the
client or refresh skill discovery if the skill is missing. In Claude Code,
check the `/` menu; in Codex, check `/skills`.

Other skill-capable hosts can install the same folders in their documented
skill location. A custom agent can load a selected `SKILL.md` as instructions
and expose the required MCP tools. Host-specific tool prefixes are expected;
the skill uses logical tool names and live schemas. Embedded Studio widgets
are optional. Local files need a host upload tool or the ability to PUT bytes
to a presigned URL; otherwise use a saved Sync asset or accessible media URL.

Installation does not submit a generation. The agent reviews costs before paid
work unless your existing authorization and the tool contract cover that work.
Edit Dialogue audio synthesis and final rendering are separate paid stages.

## Use the skills

Replace the bracketed asset placeholders with IDs from your Sync library:

> Lip-sync video asset [video asset ID] to audio asset [audio asset ID]. Show me
> the estimate before generating.

> Make this video say "Thanks for watching." Help me choose an available voice
> and show the estimated costs first.

> In my single-speaker video, change "Friday" to "Monday" in the delivery date.
> I have permission to use the speaker's voice. Let me review the audio preview
> before generating the final video.

Explicit invocation in Claude Code: `/sync-lipsync` or `/sync-edit-dialogue`,
followed by the request. In Codex: `$sync-lipsync` or `$sync-edit-dialogue`.
Natural-language requests can also select skills automatically.

If generation is still running when a session ends, retain the generation ID
and ask: "Check Sync generation [generation ID] and give me the completed output."
Do not start another generation to check progress. Dialogue recovery also needs
the project, source asset, transcription/preview IDs, and original request keys;
the agent should retain these without recording credentials.

## ChatGPT plugin

The ChatGPT package is generated from the same canonical skills. Its fourteen
skills retain the five published names: `setup`, `lipsync-video`, `talking-photo`,
`edit-dialogue`, and `translate-and-dub`. The other names are `speech`, `voices`,
`media`, `projects`, `generations`, `account`, `studio`, `transcribe`, and
`troubleshoot`. Timeline and advanced raw generation are excluded because the
ChatGPT tool profile does not support them. References describing stdio are
conditional guidance, not permission to invoke unavailable tools.

A repository merge does not publish this package to ChatGPT. Maintainers follow
[the publisher procedure](chatgpt-plugin.md) to upload and publish an approved
version separately. Until that happens, the installed app may offer the previous
five skills. The standalone folders are available directly from this repository.

## Update or remove

To update, review a newer MCP repository revision and repeat the copy command, accepting
replacement of the files you intend to update. Restart or refresh the client.
To uninstall, remove only the specific installed `sync-*` skill folders you
selected from that destination. Disconnecting the
Sync MCP server is separate and may affect other workflows. Uninstalling a skill
does not delete your Sync projects, assets, or results.

## Compatibility and troubleshooting

Missing tools: reconnect or update the MCP server, then check its exposed tool
catalog. Edit Dialogue must pass `get-dialogue-options`; it is not guaranteed by
installing the skill. Never substitute guessed API calls for an unavailable tool.

Upload/import failure: use the returned error and account limits. A social page
is not a direct media URL. Upload the source file or use an accessible asset if
that import is unavailable. A local path is not an upload by itself.

Credits or access failure: resolve the reported account/workspace issue, then
resume using known job IDs and request keys. An uncertain creation response is
not evidence that a paid job failed to start.

Timeline and feedback are absent from the ChatGPT profile. Embedded Studio needs
an app-capable profile. Advanced raw generation and additional administration
operations need stdio; installing a skill cannot unlock those on hosted clients.
Standalone transcription has a narrower saved-video path on hosted connections.

The skill format is based on [Agent Skills](https://agentskills.io/specification).
Client installation behavior follows
[Claude Code skills](https://code.claude.com/docs/en/skills) and
[OpenAI's skill guide](https://learn.chatgpt.com/docs/build-skills).

## Maintain the catalog

`skills/<name>/SKILL.md` and its resources are the canonical instructions.
`skills/catalog.json` owns availability and ChatGPT name/UI mappings. Do not edit
the generated `chatgpt-plugin/skills/` copies. To change a workflow:

```bash
pnpm skills:sync-plugin
pnpm run build
pnpm run package:chatgpt
pnpm skills:check
pnpm run test:scripts
```

The generator copies every resource and changes only the published frontmatter
name, adding the mapped `agents/openai.yaml`. Existing plugin names and onboarding
policy are compatibility contracts. Check mode validates metadata, resource
closure, exact generated output and tool ownership without rewriting files.

`docs/skills/coverage.json` maps every audited tool to an owning skill, classifies
widget-internal and stdio-only operations, lists parser exclusions and identifies
wrapper replacements. Widget-internal entries identify their existing protocol
test owner. The gate captures real HTTP and stdio handshakes/tool
lists against `fixtures/skills-openapi.generated.json`, then checks the actual
ChatGPT, Codex app, Claude.ai and Claude Code profiles. It rejects unknown tools,
missing owners, undocumented owned tools, per-profile registration drift, visibility leaks and changed parser
exclusions. A passing inventory is evidence of MCP coverage, not evidence that
every public API endpoint is exposed by MCP.

The fixture is Sync's generated public API export from the API commit recorded
in `coverage.json`, with its SHA-256 pinned there. It includes the approved
feedback contract, which may not yet be deployed by the live API. It contains
schemas, not customer media or credentials. To refresh it, export
`packages/api-client/public-openapi.json` from a reviewed sync-api-v2 revision,
replace the fixture, update provenance/hash, and rerun the capture. Review all
new registrations, wrapper replacements and filtered operations; never update
the baseline merely to silence a failure. The live schema and installed server
always determine what the agent can actually call.

For inspection without another capture:

```bash
node scripts/check-skill-coverage.mjs --capture temp/skills-wire.json
```

[Acceptance scenarios and evidence](skills/acceptance.md) distinguish automated
contract verification from live paid workflow checks.

## Hosted deployment behavior

Changes confined to `skills/`, `docs/skills/`, `docs/skills.md`, `README.md`, and
generated `chatgpt-plugin/skills/` do not restart the hosted service. The deploy
planner compares the full range from the revision actually served by `/health`
to the latest `main` tip. Any runtime, workflow, manifest, dependency or unknown
path in that range triggers a normal deployment. Missing or divergent history
also deploys. Skips smoke-check the revision actually served; real deployments
require the selected target revision and a fresh process.

The initial catalog PR changes runtime and deployment code, so it deploys normally.
