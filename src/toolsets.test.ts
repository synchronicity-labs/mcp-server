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
  'assets_get-all',
  'assets_get-download-url',
  'assets_get-many',
  'assets_update',
  'create-dialogue-preview',
  'create-dialogue-transcription',
  'create-dialogue-video',
  'create-lipsync',
  'create-speech-preview',
  'create-timeline-lipsync',
  'create-translate-and-dub',
  'create-translation-preview',
  'dialogue-edits_create-dialogue-edit',
  'dialogue-edits_get-dialogue-edit-job',
  'estimate-dialogue-video',
  'estimate-translation-preview',
  'generate_create-generation',
  'generate_estimate-cost',
  'generate_get-generation',
  'generate_get-generations',
  'generations_delete',
  'generations_estimate-cost',
  'generations_get-by-id',
  'generations_get-count',
  'generations_get-download-url',
  'generations_update-output-file-name',
  'get-account-context',
  'get-account-usage',
  'get-audio-trim',
  'get-dialogue-options',
  'get-dialogue-preview',
  'get-dialogue-transcription',
  'get-generation-continuation',
  'get-generation-costs',
  'get-playback-metadata',
  'get-speech-options',
  'get-speech-preview',
  'get-translation-options',
  'get-translation-preview',
  'jobs_get',
  'jobs_wait',
  'models_get',
  'projects_attach-asset',
  'projects_create',
  'projects_delete',
  'projects_detach-asset',
  'projects_get',
  'projects_get-all',
  'projects_get-generations',
  'projects_update',
  'rename-project',
  'send-feedback',
  'transcriptions_analyze-speakers',
  'transcriptions_create-transcription',
  'transcriptions_get-speaker-analysis',
  'transcriptions_get-transcription-job',
  'transcriptions_slice-speaker-face-track',
  'trim-audio',
  'tts_create',
  'tts_create-job',
  'tts_get-job',
  'upload-dialogue-source',
  'voices_clone-voice',
  'voices_delete-voice',
  'voices_get-voice',
  'voices_get-voices',
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
      'voices_clone-voice',
      'voices_delete-voice',
    ]);
    for (const name of admin) expect(listed(), name).not.toContain(name);
  });

  it('defaults to the hosted set without admin, plus the jobs and transcription tools', () => {
    const extra = listed().filter((name) => !HOSTED_HTTP_TOOL_ALLOWLIST.has(name));
    expect(extra).toEqual([
      'jobs_get',
      'jobs_wait',
      'transcriptions_analyze-speakers',
      'transcriptions_create-transcription',
      'transcriptions_get-speaker-analysis',
      'transcriptions_get-transcription-job',
      'transcriptions_slice-speaker-face-track',
    ]);
    const missing = PRODUCTION_STDIO_TOOLS.filter(
      (name) => HOSTED_HTTP_TOOL_ALLOWLIST.has(name) && !listed().includes(name),
    );
    expect(missing).toEqual(['assets_delete', 'voices_clone-voice']);
    expect(listed(['default'])).toEqual(listed());
    expect(listed([])).toEqual(listed());
  });

  it('lists everything with all', () => {
    expect(listed(['all'])).toEqual(PRODUCTION_STDIO_TOOLS);
    expect(listed(['lipsync', 'all'])).toEqual(PRODUCTION_STDIO_TOOLS);
  });
});
