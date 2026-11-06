# Tool names

Tools are named `<noun>_<verb>`: the noun is the thing the tool works on, in the plural
where the API uses it (`generations`, `assets`, `translation-previews`), and the verb is
what it does to it (`get`, `list`, `create`, `estimate`). Before CRAFT-7786 the hand-written
tools used `<verb>-<noun>` (`create-lipsync`) while generated ones used the API
operationId (`assets_get-all`). The table below lists every name that changed. Tools that
are not listed, such as `assets_create`, `projects_get` and `jobs_wait`, kept their names.

## Old names keep working

- **Every old name is still callable** for a deprecation period. It runs the same tool
  with the same input and returns the same result, plus one trailing text block:
  `Tool <old> is now named <new>; call <new> from now on, …`. The notice comes after the
  JSON text, so `structuredContent` and the first content block don't change.
- **`tools/list` shows only new names**, except in clients with the ChatGPT app UI
  (`openai-mcp`, `openai-mcp (Codex)`). There, every renamed tool a widget can call is also
  listed under its old name as an app-only tool (`ui.visibility: ["app"]`), which the model
  does not see. Widgets can call only listed, widget-accessible tools, and ChatGPT keeps
  the earlier Studio bundles (`deploy/chatgpt/`, one current and eleven previous) and
  widget templates, which call tools by their old names. Claude (`claude`, `claude-ai`, `Anthropic/ClaudeAI`)
  renders only the generation status card, so it lists just the one old name the card
  calls, `generate_get-generation`, as app-only (`withStatusCardTool` in
  `src/generation-status.ts`).
- **Analytics** events still carry the old names, because the deployed collector's
  `tool_name` enum lists them. Moving the collector to the new names is a separate API change.
- `generations_estimate-cost` was the stdio-only `GenerationsController_estimateCost`
  and is now the curated estimate (formerly `generate_estimate-cost`), which takes the
  same input. The stdio-only operation is now `generations_estimate`.
- `open-sync-app` was first renamed `app_open`, which was live from `b0c91b3`. OpenAI's
  review flagged that name as unclear, so the tool is now `sync-app_open`, and both old
  names stay callable as aliases. Analytics keep reporting `open-sync-app`, the original.
- A raw generated operation never takes a renamed tool's new name. For example, the
  unversioned `StudioViewsController_get` would derive `studio-views_get`
  (`nameTakenByRenamedTool` in `src/tool-names.ts`).

## Removing the old names

`src/tool-names.ts` keeps two things apart:

- `RENAMED_TOOLS` is the permanent record of every rename. Generated tools get their names
  through it (`AssetsController_getAll` derives `assets_get-all`, named `assets_list`),
  it reserves the new names from raw operations, and analytics read the old names from
  it. Never delete its entries: the generated tools would go back to their old names
  and fall out of the hosted allowlist.
- `OLD_NAME_ALIASES` is the temporary part: the old names still callable, announced
  and, on app profiles, listed as app-only tools.

After the Studio bundle built against the new names has been current for longer than
ChatGPT keeps an old widget, and after a Rescan, remove names from `OLD_NAME_ALIASES`
(eventually all of them). That ends their aliases, app-only listings and notices together.

## Old → new

| Old name | New name | Where |
| --- | --- | --- |
| `create-lipsync` | `lipsync_create` | hosted |
| `create-lipsync-from-assets` | `lipsync_create-from-assets` | hosted |
| `create-timeline-lipsync` | `lipsync_create-timeline` | hosted |
| `generate_create-generation` | `generations_create` | local |
| `generate_get-generation` | `generations_get` | hosted |
| `generate_get-generations` | `generations_list` | hosted |
| `generate_estimate-cost` | `generations_estimate-cost` | hosted |
| `generations_estimate-cost` | `generations_estimate` | local |
| `generations_get-by-id` | `generations_get-details` | local |
| `generations_get-count` | `generations_count` | local |
| `get-generation-costs` | `generations_get-costs` | hosted |
| `get-generation-continuation` | `generations_get-continuation` | hosted |
| `models_get` | `models_list` | hosted |
| `create-translate-and-dub` | `dubbing_create` | hosted |
| `get-translation-options` | `dubbing_get-options` | hosted |
| `estimate-translation-preview` | `translation-previews_estimate` | hosted |
| `create-translation-preview` | `translation-previews_create` | hosted |
| `get-translation-preview` | `translation-previews_get` | hosted |
| `get-speech-options` | `speech-previews_get-options` | hosted |
| `create-speech-preview` | `speech-previews_create` | hosted |
| `get-speech-preview` | `speech-previews_get` | hosted |
| `voices_get-voices` | `voices_list` | hosted |
| `voices_get-voice` | `voices_get` | local |
| `voices_clone-voice` | `voices_clone` | hosted |
| `voices_delete-voice` | `voices_delete` | local |
| `tts_create-job` | `tts-jobs_create` | local |
| `tts_get-job` | `tts-jobs_get` | local |
| `get-dialogue-options` | `dialogue_get-options` | hosted |
| `upload-dialogue-source` | `dialogue_upload-source` | hosted |
| `create-dialogue-transcription` | `dialogue-transcriptions_create` | hosted |
| `get-dialogue-transcription` | `dialogue-transcriptions_get` | hosted |
| `create-dialogue-preview` | `dialogue-previews_create` | hosted |
| `get-dialogue-preview` | `dialogue-previews_get` | hosted |
| `estimate-dialogue-video` | `dialogue-videos_estimate` | hosted |
| `create-dialogue-video` | `dialogue-videos_create` | hosted |
| `dialogue-edits_create-dialogue-edit` | `dialogue-edits_create` | local |
| `dialogue-edits_get-dialogue-edit-job` | `dialogue-edits_get` | local |
| `transcriptions_create-transcription` | `transcriptions_create` | local |
| `transcriptions_get-transcription-job` | `transcriptions_get` | local |
| `assets_get-all` | `assets_list` | hosted |
| `get-playback-metadata` | `assets_get-playback-metadata` | hosted |
| `get-asset-creators` | `assets_list-creators` | hosted |
| `upload-media` | `assets_upload` | hosted |
| `open-upload-widget` | `assets_open-upload-widget` | hosted |
| `trim-audio` | `audio-trims_create` | hosted |
| `get-audio-trim` | `audio-trims_get` | hosted |
| `projects_get-all` | `projects_list` | hosted |
| `projects_get-generations` | `projects_list-generations` | hosted |
| `rename-project` | `projects_rename` | hosted |
| `get-account-context` | `account_get-context` | hosted |
| `get-account-usage` | `account_get-usage` | hosted |
| `send-feedback` | `feedback_send` | hosted |
| `track-chatgpt-event` | `analytics_track-event` | hosted |
| `open-sync-app` | `sync-app_open` | hosted |
| `app_open` | `sync-app_open` | hosted |
| `get-studio-view` | `studio-views_get` | hosted |
| `open-studio-project` | `studio-views_open-project` | hosted |
| `refresh-studio-project` | `studio-views_refresh-project` | hosted |
| `refresh-studio-assets` | `studio-views_refresh-assets` | hosted |
| `show-studio-generation` | `studio-views_show-generation` | hosted |
| `continue-studio-generation` | `studio-views_continue-generation` | hosted |
| `register-studio-view` | `studio-views_register` | hosted |
| `ack-studio-view` | `studio-views_ack` | hosted |
| `get-studio-draft` | `studio-drafts_get` | hosted |
| `update-studio-draft` | `studio-drafts_update` | hosted |
| `save-studio-draft` | `studio-drafts_save` | hosted |
| `ack-studio-draft` | `studio-drafts_ack` | hosted |
