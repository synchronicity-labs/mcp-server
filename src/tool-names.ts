import type { Tool } from '@modelcontextprotocol/server';

/**
 * Tool names follow one `<noun>_<verb>` scheme (CRAFT-7786). The names below are the
 * previous ones. Each stays callable as an alias that tools/list does not show, and a
 * call through one gets a notice naming the new tool. Apps that support the ChatGPT UI
 * also list the aliases their widgets call as app-only tools, because retained Studio
 * bundles and widget templates keep calling the old names; see docs/tool-names.md.
 *
 * Generated tools are renamed here too: operationIdToToolName derives the old name from
 * the API operationId, then maps it. Remove entries only after the deprecation period.
 */
export const RENAMED_TOOLS: Readonly<Record<string, string>> = {
  'create-lipsync': 'lipsync_create',
  'create-lipsync-from-assets': 'lipsync_create-from-assets',
  'create-timeline-lipsync': 'lipsync_create-timeline',
  'generate_create-generation': 'generations_create',
  'generate_get-generation': 'generations_get',
  'generate_get-generations': 'generations_list',
  'generate_estimate-cost': 'generations_estimate-cost',
  'generations_estimate-cost': 'generations_estimate',
  'generations_get-by-id': 'generations_get-details',
  'generations_get-count': 'generations_count',
  'get-generation-costs': 'generations_get-costs',
  'get-generation-continuation': 'generations_get-continuation',
  models_get: 'models_list',
  'create-translate-and-dub': 'dubbing_create',
  'get-translation-options': 'dubbing_get-options',
  'estimate-translation-preview': 'translation-previews_estimate',
  'create-translation-preview': 'translation-previews_create',
  'get-translation-preview': 'translation-previews_get',
  'get-speech-options': 'speech-previews_get-options',
  'create-speech-preview': 'speech-previews_create',
  'get-speech-preview': 'speech-previews_get',
  'voices_get-voices': 'voices_list',
  'voices_get-voice': 'voices_get',
  'voices_clone-voice': 'voices_clone',
  'voices_delete-voice': 'voices_delete',
  'tts_create-job': 'tts-jobs_create',
  'tts_get-job': 'tts-jobs_get',
  'get-dialogue-options': 'dialogue_get-options',
  'upload-dialogue-source': 'dialogue_upload-source',
  'create-dialogue-transcription': 'dialogue-transcriptions_create',
  'get-dialogue-transcription': 'dialogue-transcriptions_get',
  'create-dialogue-preview': 'dialogue-previews_create',
  'get-dialogue-preview': 'dialogue-previews_get',
  'estimate-dialogue-video': 'dialogue-videos_estimate',
  'create-dialogue-video': 'dialogue-videos_create',
  'dialogue-edits_create-dialogue-edit': 'dialogue-edits_create',
  'dialogue-edits_get-dialogue-edit-job': 'dialogue-edits_get',
  'transcriptions_create-transcription': 'transcriptions_create',
  'transcriptions_get-transcription-job': 'transcriptions_get',
  'assets_get-all': 'assets_list',
  'get-playback-metadata': 'assets_get-playback-metadata',
  'get-asset-creators': 'assets_list-creators',
  'upload-media': 'assets_upload',
  'open-upload-widget': 'assets_open-upload-widget',
  'trim-audio': 'audio-trims_create',
  'get-audio-trim': 'audio-trims_get',
  'projects_get-all': 'projects_list',
  'projects_get-generations': 'projects_list-generations',
  'rename-project': 'projects_rename',
  'get-account-context': 'account_get-context',
  'get-account-usage': 'account_get-usage',
  'send-feedback': 'feedback_send',
  'track-chatgpt-event': 'analytics_track-event',
  'open-sync-app': 'app_open',
  'get-studio-view': 'studio-views_get',
  'open-studio-project': 'studio-views_open-project',
  'refresh-studio-project': 'studio-views_refresh-project',
  'refresh-studio-assets': 'studio-views_refresh-assets',
  'show-studio-generation': 'studio-views_show-generation',
  'continue-studio-generation': 'studio-views_continue-generation',
  'register-studio-view': 'studio-views_register',
  'ack-studio-view': 'studio-views_ack',
  'get-studio-draft': 'studio-drafts_get',
  'update-studio-draft': 'studio-drafts_update',
  'save-studio-draft': 'studio-drafts_save',
  'ack-studio-draft': 'studio-drafts_ack',
};

const LEGACY_BY_NAME = new Map(
  Object.entries(RENAMED_TOOLS).map(([legacy, name]) => [name, legacy]),
);

/** The current name for a name derived from an operationId or used before the rename. */
export function currentToolName(name: string): string {
  return RENAMED_TOOLS[name] ?? name;
}

const CURRENT_NAMES = new Set(Object.values(RENAMED_TOOLS));

/**
 * True when a generated tool's derived name is already a renamed tool's new name, such as
 * StudioViewsController_get → studio-views_get. The hand-written tool owns that name, so
 * the raw operation is never exposed under it.
 */
export function nameTakenByRenamedTool(derived: string): boolean {
  return !(derived in RENAMED_TOOLS) && CURRENT_NAMES.has(derived);
}

/** The name a tool had before the rename, if it changed. */
export function legacyToolName(name: string): string | undefined {
  return LEGACY_BY_NAME.get(name);
}

export function renamedToolNotice(legacy: string, name: string): string {
  return `Tool ${legacy} is now named ${name}; call ${name} from now on, as the old name will stop working after the deprecation period.`;
}

/**
 * Widgets cannot call a tool that is not listed, and ChatGPT keeps earlier Studio bundles
 * and widget templates that call tools by their old names. On app profiles, list those
 * old names as app-only tools (the model does not see them) for the deprecation period.
 */
export function withLegacyAppDescriptors(descriptors: Tool[]): Tool[] {
  const current = new Set(descriptors.map((descriptor) => descriptor.name));
  const legacy = descriptors.flatMap((descriptor) => {
    const name = legacyToolName(descriptor.name);
    const meta = descriptor._meta ?? {};
    const ui = (meta.ui ?? {}) as { visibility?: unknown };
    const forApp =
      (Array.isArray(ui.visibility) && ui.visibility.includes('app')) ||
      meta['openai/widgetAccessible'] === true;
    if (!name || !forApp || current.has(name)) return [];
    return [
      {
        ...descriptor,
        name,
        description: `Deprecated name of ${descriptor.name}, kept for Sync app widgets. Call ${descriptor.name}.`,
        _meta: { ...meta, ui: { ...ui, visibility: ['app'] } },
      },
    ];
  });
  return [...descriptors, ...legacy];
}
