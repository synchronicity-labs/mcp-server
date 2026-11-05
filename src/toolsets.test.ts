import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from './config.js';
import { HOSTED_HTTP_TOOL_ALLOWLIST } from './server.js';
import { parseToolsets, type Toolset, toolCategory, toolsetIncludes } from './toolsets.js';

// The local catalog against production api-json on 2026-11-05, plus the jobs tools and
// the speaker tools the API has not published yet. Refresh it when the catalog grows.
const PRODUCTION_STDIO_TOOLS = [
  'assets_count',
  'assets_create',
  'assets_create-upload-url',
  'assets_delete',
  'assets_get',
  'assets_list',
  'assets_get-download-url',
  'assets_get-many',
  'assets_update',
  'batches_create',
  'batches_get',
  'batches_list',
  'dialogue-previews_create',
  'dialogue-transcriptions_create',
  'dialogue-videos_create',
  'lipsync_create',
  'speech-previews_create',
  'lipsync_create-timeline',
  'dubbing_create',
  'translation-previews_create',
  'dialogue-edits_create',
  'dialogue-edits_get',
  'dialogue-videos_estimate',
  'translation-previews_estimate',
  'generations_create',
  'generations_estimate-cost',
  'generations_get',
  'generations_list',
  'generations_delete',
  'generations_estimate',
  'generations_get-details',
  'generations_count',
  'generations_get-download-url',
  'generations_update-output-file-name',
  'account_get-context',
  'account_get-usage',
  'audio-trims_get',
  'dialogue_get-options',
  'dialogue-previews_get',
  'dialogue-transcriptions_get',
  'generations_get-continuation',
  'generations_get-costs',
  'assets_get-playback-metadata',
  'speech-previews_get-options',
  'speech-previews_get',
  'dubbing_get-options',
  'translation-previews_get',
  'jobs_get',
  'jobs_wait',
  'models_list',
  'projects_attach-asset',
  'projects_create',
  'projects_delete',
  'projects_detach-asset',
  'projects_get',
  'projects_list',
  'projects_list-generations',
  'projects_update',
  'projects_rename',
  'feedback_send',
  'transcriptions_analyze-speakers',
  'transcriptions_create',
  'transcriptions_get-speaker-analysis',
  'transcriptions_get',
  'transcriptions_slice-speaker-face-track',
  'audio-trims_create',
  'tts_create',
  'tts-jobs_create',
  'tts-jobs_get',
  'dialogue_upload-source',
  'voices_clone',
  'voices_delete',
  'voices_get',
  'voices_list',
];

const listed = (selection?: Toolset[]) =>
  PRODUCTION_STDIO_TOOLS.filter((name) =>
    toolsetIncludes(selection, name, HOSTED_HTTP_TOOL_ALLOWLIST),
  );

describe('toolsets', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('parses comma- or space-separated names and rejects unknown ones', () => {
    expect(parseToolsets(undefined)).toBeUndefined();
    expect(parseToolsets('  ')).toBeUndefined();
    expect(parseToolsets('Lipsync, admin lipsync')).toEqual(['lipsync', 'admin']);
    expect(() => parseToolsets('lipsync,everything')).toThrow(
      'Unknown toolset "everything"; use default, lipsync, dubbing, assets, projects, transcription, voices, admin, all.',
    );
  });

  it('reads SYNC_MCP_TOOLSETS, and the CLI value wins', () => {
    vi.stubEnv('SYNC_MCP_TOOLSETS', 'voices,admin');
    expect(resolveConfig().toolsets).toEqual(['voices', 'admin']);
    expect(resolveConfig({ toolsets: ['all'] }).toolsets).toEqual(['all']);
    vi.stubEnv('SYNC_MCP_TOOLSETS', '');
    expect(resolveConfig().toolsets).toBeUndefined();
  });

  it('puts every tool in the production catalog in a toolset', () => {
    const categorized = listed([
      'lipsync',
      'dubbing',
      'assets',
      'projects',
      'transcription',
      'voices',
      'admin',
    ]);
    expect(PRODUCTION_STDIO_TOOLS.filter((name) => !categorized.includes(name))).toEqual([]);
  });

  it('keeps deletes and voice cloning in admin only', () => {
    const admin = PRODUCTION_STDIO_TOOLS.filter((name) => toolCategory(name) === 'admin');
    expect(admin).toEqual([
      'assets_delete',
      'generations_delete',
      'projects_delete',
      'voices_clone',
      'voices_delete',
    ]);
    for (const name of admin) expect(listed(), name).not.toContain(name);
  });

  it('defaults to the hosted set without admin, plus the jobs and transcription tools', () => {
    const extra = listed().filter((name) => !HOSTED_HTTP_TOOL_ALLOWLIST.has(name));
    expect(extra).toEqual([
      'jobs_get',
      'jobs_wait',
      'transcriptions_analyze-speakers',
      'transcriptions_create',
      'transcriptions_get-speaker-analysis',
      'transcriptions_get',
      'transcriptions_slice-speaker-face-track',
    ]);
    const missing = PRODUCTION_STDIO_TOOLS.filter(
      (name) => HOSTED_HTTP_TOOL_ALLOWLIST.has(name) && !listed().includes(name),
    );
    expect(missing).toEqual(['assets_delete', 'voices_clone']);
    expect(listed(['default'])).toEqual(listed());
    expect(listed([])).toEqual(listed());
  });

  it('lists everything with all', () => {
    expect(listed(['all'])).toEqual(PRODUCTION_STDIO_TOOLS);
    expect(listed(['lipsync', 'all'])).toEqual(PRODUCTION_STDIO_TOOLS);
  });
});
