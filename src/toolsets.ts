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
  'get-account-context',
  'organizations_list',
  'organizations_select',
  'get-account-usage',
  'models_get',
  'send-feedback',
  'generate_get-generation',
  'generate_get-generations',
  'generate_estimate-cost',
  'get-generation-costs',
  'get-generation-continuation',
  'get-playback-metadata',
  'get-asset-creators',
  // App-only tools; isToolVisible still hides them from clients without the app UI.
  'track-chatgpt-event',
  'open-sync-app',
  'get-studio-view',
  'open-studio-project',
  'refresh-studio-project',
  'refresh-studio-assets',
  'show-studio-generation',
  'continue-studio-generation',
  'register-studio-view',
  'ack-studio-view',
  'get-studio-draft',
  'update-studio-draft',
  'save-studio-draft',
  'ack-studio-draft',
]);

// Hand-written tools. Generated tools fall back to their API controller below.
const CATEGORY_BY_TOOL: Record<string, Category> = {
  'create-lipsync': 'lipsync',
  'create-lipsync-from-assets': 'lipsync',
  'create-timeline-lipsync': 'lipsync',
  'trim-audio': 'lipsync',
  'get-audio-trim': 'lipsync',
  'get-dialogue-options': 'lipsync',
  'upload-dialogue-source': 'lipsync',
  'create-dialogue-transcription': 'lipsync',
  'get-dialogue-transcription': 'lipsync',
  'create-dialogue-preview': 'lipsync',
  'get-dialogue-preview': 'lipsync',
  'estimate-dialogue-video': 'lipsync',
  'create-dialogue-video': 'lipsync',
  'create-translate-and-dub': 'dubbing',
  'get-translation-options': 'dubbing',
  'estimate-translation-preview': 'dubbing',
  'create-translation-preview': 'dubbing',
  'get-translation-preview': 'dubbing',
  'upload-media': 'assets',
  'open-upload-widget': 'assets',
  'rename-project': 'projects',
  'get-speech-options': 'voices',
  'create-speech-preview': 'voices',
  'get-speech-preview': 'voices',
  // Creates a persistent voice from someone's recording; not idempotent.
  'voices_clone-voice': 'admin',
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
 * workflows need there: jobs_get and jobs_wait, and the transcription tools whose speaker
 * face tracks become create-timeline-lipsync clips.
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
