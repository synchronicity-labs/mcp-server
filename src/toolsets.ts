/**
 * Toolsets for the local (stdio) server. It used to list a tool for every public API
 * operation (65+), which crowds an agent's context; by default it now lists the curated
 * set the hosted server offers, plus what those workflows need. An operator picks more
 * with SYNC_MCP_TOOLSETS or --toolsets; agents cannot. The hosted server ignores this.
 */
export const TOOLSETS = [
  'default',
  'lipsync',
  'dubbing',
  'assets',
  'projects',
  'transcription',
  'voices',
  'admin',
  'all',
] as const;
export type Toolset = (typeof TOOLSETS)[number];
type Category = Exclude<Toolset, 'default' | 'all'>;

// Listed with every selection: reading jobs, account state and the app's own helpers.
const CORE = new Set([
  'jobs_get',
  'jobs_wait',
  'jobs_get-many',
  // Offered only when a create tool it runs is listed too.
  'jobs_create-many',
  'account_get-context',
  'organizations_list',
  'organizations_select',
  'account_get-usage',
  // Any paid workflow can be refused for a plan or credits; a person approves the payment.
  'billing-approval-links_create',
  // What a plan or credits cost, before either is bought.
  'billing-plans_list',
  'models_list',
  'feedback_send',
  'generations_get',
  'generations_list',
  'generations_estimate-cost',
  'generations_get-costs',
  'generations_get-continuation',
  'assets_get-playback-metadata',
  'assets_list-creators',
  // App-only tools; isToolVisible still hides them from clients without the app UI.
  'analytics_track-event',
  'sync-app_open',
  'studio-views_get',
  'studio-views_open-project',
  'studio-views_refresh-project',
  'studio-views_refresh-assets',
  'studio-views_show-generation',
  'studio-views_continue-generation',
  'studio-views_register',
  'studio-views_ack',
  'studio-drafts_get',
  'studio-drafts_update',
  'studio-drafts_save',
  'studio-drafts_ack',
]);

// Hand-written tools. Generated tools fall back to their API controller below.
const CATEGORY_BY_TOOL: Record<string, Category> = {
  lipsync_create: 'lipsync',
  'lipsync_create-from-assets': 'lipsync',
  'lipsync_create-timeline': 'lipsync',
  'audio-trims_create': 'lipsync',
  'audio-trims_get': 'lipsync',
  'dialogue_get-options': 'lipsync',
  'dialogue_upload-source': 'lipsync',
  'dialogue-transcriptions_create': 'lipsync',
  'dialogue-transcriptions_get': 'lipsync',
  'dialogue-previews_create': 'lipsync',
  'dialogue-previews_get': 'lipsync',
  'dialogue-videos_estimate': 'lipsync',
  'dialogue-videos_create': 'lipsync',
  dubbing_create: 'dubbing',
  'dubbing_get-options': 'dubbing',
  'translation-previews_estimate': 'dubbing',
  'translation-previews_create': 'dubbing',
  'translation-previews_get': 'dubbing',
  // Feature-gated: listed only to accounts with the feature (account-features.ts).
  scenes_detect: 'lipsync',
  stems_separate: 'assets',
  faces_detect: 'lipsync',
  faces_get: 'lipsync',
  'faces_get-timeline': 'lipsync',
  'faces_get-people': 'lipsync',
  shots_regenerate: 'lipsync',
  shots_splice: 'lipsync',
  shots_review: 'lipsync',
  assets_upload: 'assets',
  'assets_open-upload-widget': 'assets',
  projects_rename: 'projects',
  'speech-previews_get-options': 'voices',
  'speech-previews_create': 'voices',
  'speech-previews_get': 'voices',
  // Creates a persistent voice from someone's recording; not idempotent.
  voices_clone: 'admin',
  // Batches of /v2/generate bodies; dubbing lists them too, for localizing many videos.
  batches_create: 'lipsync',
  batches_get: 'lipsync',
  batches_list: 'lipsync',
};

// Tools a second toolset lists as well.
const ALSO_IN: Record<string, Category> = {
  batches_create: 'dubbing',
  batches_get: 'dubbing',
  batches_list: 'dubbing',
};

const CATEGORY_BY_CONTROLLER: Record<string, Category> = {
  generate: 'lipsync',
  generations: 'lipsync',
  'dialogue-edits': 'lipsync',
  integrations: 'dubbing',
  dubbing: 'dubbing',
  assets: 'assets',
  projects: 'projects',
  transcriptions: 'transcription',
  voices: 'voices',
  tts: 'voices',
  'tts-jobs': 'voices',
};

// Deletes stay in admin whatever their controller.
const DELETES = /(?:^|[_-])(?:delete|remove)(?:[_-]|$)/;

/** The toolset a tool belongs to, or undefined for a tool only `all` lists. */
export function toolCategory(name: string): Category | undefined {
  if (DELETES.test(name)) return 'admin';
  if (CATEGORY_BY_TOOL[name]) return CATEGORY_BY_TOOL[name];
  const controller = name.includes('_') ? name.slice(0, name.indexOf('_')) : undefined;
  return controller ? CATEGORY_BY_CONTROLLER[controller] : undefined;
}

/**
 * The default: what the hosted server lists, without admin tools, plus what the curated
 * workflows need there: the jobs_* tools, and the transcription tools whose speaker
 * face tracks become lipsync_create-timeline clips.
 */
function inDefaultToolset(name: string, hostedTools: ReadonlySet<string>): boolean {
  if (toolCategory(name) === 'admin') return false;
  return CORE.has(name) || hostedTools.has(name) || toolCategory(name) === 'transcription';
}

export function toolsetIncludes(
  selection: readonly Toolset[] | undefined,
  name: string,
  hostedTools: ReadonlySet<string>,
): boolean {
  const chosen = selection?.length ? selection : (['default'] as const);
  if (chosen.includes('all')) return true;
  if (chosen.includes('default') && inDefaultToolset(name, hostedTools)) return true;
  if (CORE.has(name)) return true;
  const categories = [toolCategory(name), ALSO_IN[name]];
  return categories.some((category) => category !== undefined && chosen.includes(category));
}

/** Comma- or space-separated toolset names; empty means the default. */
export function parseToolsets(value: string | undefined): Toolset[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const names = value
    .split(/[\s,]+/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter((name) => !(TOOLSETS as readonly string[]).includes(name));
  if (unknown.length > 0)
    throw new Error(
      `Unknown toolset ${unknown.map((name) => `"${name}"`).join(', ')}; use ${TOOLSETS.join(', ')}.`,
    );
  return [...new Set(names)] as Toolset[];
}

/** The server instructions' note on what this connection lists, or '' when it lists everything. */
export function toolsetInstruction(selection: readonly Toolset[] | undefined): string {
  const chosen = selection?.length ? selection : (['default'] as const);
  if (chosen.includes('all')) return '';
  return `This local server lists the ${chosen.join(', ')} Sync toolset${chosen.length > 1 ? 's' : ''}, not every API tool; delete tools and voice cloning are in admin. If the user needs a tool that is not listed, tell them to restart the server with SYNC_MCP_TOOLSETS=all (or --toolsets all), or to add toolsets such as default,admin.`;
}
