import type { z } from 'zod';
import { ASSET_THUMBNAIL_INSTRUCTIONS } from '../asset-thumbnail.js';
import { generationOutputSchema } from './output-schemas.js';

type ToolOverride = {
  title?: string;
  description: string;
  outputSchema?: Record<string, z.ZodType>;
};

// Agent-friendly descriptions, keyed by generated tool name
// (operationIdToToolName). These encode the end-to-end workflow
// (discover models/voices → upload assets → tts → generate → poll) and tell the
// agent what to do next, so the tool list reads like a runbook. Endpoints
// without an entry fall back to the OpenAPI summary.
const TOOL_OVERRIDES: Record<string, ToolOverride> = {
  // --- Discovery ---
  models_get: {
    title: 'List Sync models',
    description:
      'List Sync models with their type, features and deprecation status. Some listed models serve other workflows, such as appearance editing; use only a non-deprecated lipsync model in create-lipsync. Use a returned model name as-is; do not invent model names.',
  },
  'voices_get-voices': {
    title: 'List voices',
    description:
      'List available voices: premade ElevenLabs voices plus voices your org has cloned. For "make this image/video say X", use an available returned voice `id` as `voiceId` in create-lipsync with `script` directly. Respect any returned restriction. Use this to find an existing clone before creating another.',
  },

  // --- Assets (upload + manage reusable media) ---
  'assets_create-upload-url': {
    title: 'Get a media upload URL',
    description:
      'Upload step 1: get a presigned URL for a local file. PUT the raw bytes to the returned `uploadUrl` (same Content-Type), then register it with assets_create using the returned `url`. Use this when your media is not already at a public URL. Max 5GB.',
  },
  assets_create: {
    title: 'Register a media asset',
    description:
      'Register a direct media URL or import a YouTube, TikTok, Instagram or Facebook video link as a reusable asset. For a social link, pass url, type=VIDEO and the selected projectId. A 409 import_in_progress means the download is running: wait retryAfterMs (15 seconds if absent), then repeat this exact request with the same URL and project. The API reuses the import and returns its saved VIDEO asset when ready. Never use importJobId as an asset ID. Stop on import_failed, import_not_enabled, import_unavailable or import limits and explain the error; do not automatically restart. Returns an asset id for generation inputs or videoAssetId in create-translate-and-dub when available. Import first, then estimate and confirm translation. Link imports have daily limits.',
  },
  'assets_get-all': {
    title: 'List assets',
    description:
      'List assets (video/audio/image) in your organization. Use to find an existing assetId. Pass a small `limit` and narrow with `searchQuery`, `types` or `projectId`. ' +
      ASSET_THUMBNAIL_INSTRUCTIONS,
  },
  assets_get: {
    title: 'Get an asset',
    description: 'Get one asset by id (details + URL). ' + ASSET_THUMBNAIL_INSTRUCTIONS,
  },
  assets_update: {
    title: 'Update an asset',
    description:
      'Rename an asset or change its visibility by id. Change only what the user asked for.',
  },
  assets_delete: {
    title: 'Delete an asset',
    description:
      'Delete an asset by id. Use only on an explicit user request, after confirming which asset.',
  },
  assets_count: {
    title: 'Count assets',
    description:
      'Count assets matching the same filters as assets_get-all (project, creator, search text, type). Returns a number, not the assets.',
  },
  'assets_get-download-url': {
    title: 'Get an asset download URL',
    description:
      'Get a download URL for an accessible asset. Return the URL exactly as given; signed URLs must not be edited.',
  },

  // --- Voices (clone + manage) ---
  'voices_clone-voice': {
    title: 'Clone a voice',
    description:
      'Use this when the user explicitly wants to save a reusable clone of their own voice or a voice they have permission to clone. Confirm the sample and name first; plan limits and provider requirements apply, so do not claim this is free. Pass exactly one of a Sync-hosted `url`, accessible `assetId`, or `sampleUrls` (up to 10 Sync-hosted samples), plus `provider` (elevenlabs) and `name`. Upload/register local samples first. Video samples have audio extracted by the API. Returns a Sync `id`: use that id as `voiceId` in create-lipsync with script, not the provider-specific `voiceId` field. Do not use for Edit Dialogue previews, selecting an existing voice, or designing a voice from a text description. This creates a persistent voice and is not idempotent. On timeout or uncertain failure, list voices and reconcile; never automatically retry. Surface API plan limits, sample errors and duplicate-name errors without retrying or changing accounts.',
  },
  'voices_delete-voice': {
    description: 'Delete a cloned voice by id, freeing a clone slot.',
  },

  // --- Text-to-speech ---
  tts_create: {
    description:
      'Synthesize standalone speech audio from text. Use only when the user specifically asks for an audio file or voice preview. Do not use this for "make this image/video say X" lipsync requests — use create-lipsync with `script` and `voiceId` directly.',
  },

  // --- Generate + poll ---
  'generate_create-generation': {
    description:
      'Create a lipsync video. Provide a video input (or an image for sync-3) and an audio input, each by `url` or `assetId`. Returns a generation `id` — call generate_get-generation with `wait: true` and omit `timeout` to use the API default. If still pending, poll the same id; when completed, read `outputUrl`. To choose which face to sync in a multi-person video, pass `options.active_speaker_detection` (auto_detect, or coordinates + frame_number).',
    outputSchema: generationOutputSchema,
  },
  'generate_get-generation': {
    title: 'Get a generation',
    description:
      'Get a generation by id. Pass `wait: true` and omit `timeout` to use the API default. If still pending, poll the same generation id again; never resubmit the generation. When status is COMPLETED, copy the exact `structuredContent.outputUrl` string verbatim; signed URLs must not be reconstructed, shortened, or edited.',
    outputSchema: generationOutputSchema,
  },
  'generate_get-generations': {
    title: 'List generations',
    description:
      'List recent generations for your organization to find generation ids or check status. Pass a small `limit`, or narrow with its filters; for the history of one project, prefer projects_get-generations when available.',
  },
  'generate_estimate-cost': {
    title: 'Estimate generation cost',
    description:
      'Estimate Sync cost before generating. For replacement speech, supply model and script (approximate spoken duration), or audioDuration (measured seconds once audio exists). These override duration; do not quote the full source video length for a shorter replacement script. For video cut_off or silence supply videoDuration and the selected syncMode; for images set visualType=image and omit videoDuration. Otherwise supply billable output duration in seconds, optional fps and reasoningEnabled. Explain returned durationEstimate, label script estimates approximate, and disclose that speech synthesis is excluded. If the schema supports workflow=translate-and-dub, use it for both stages and show the returned breakdown; disclose excluded external provider charges. Otherwise this prices lip-sync only. Does not create jobs or reserve credits.',
  },
  'generations_get-by-id': {
    description:
      'Get a generation by id (organization-scoped). Returns status and, when COMPLETED, `outputUrl`.',
    outputSchema: generationOutputSchema,
  },
  generations_delete: {
    description:
      'Delete a generation by id. Only terminal generations (COMPLETED/FAILED/REJECTED) can be deleted — deleting one that is still processing returns 409.',
  },
  'generations_estimate-cost': {
    description:
      'Estimate generation cost before creating it. For replacement speech supply script for an approximate spoken-duration quote, or measured audioDuration once audio exists, instead of source video duration. For video cut_off or silence supply videoDuration and the selected syncMode; for images set visualType=image and omit videoDuration. Explain returned durationEstimate; speech synthesis is excluded. For translate-and-dub use source duration and disclose excluded external provider charges.',
  },

  // --- Projects (group generations + assets) ---
  projects_create: {
    title: 'Create a project',
    description:
      'Create a project to group related generations and assets. Pass the returned `id` as `projectId` to create-lipsync or assets_create so they show up together in Studio. Use by default for a new workflow request, even if an existing project has the same name. Supply a fresh UUID id and preserve it on retries. Project names never select existing work.',
  },
  'projects_get-all': {
    title: 'List projects',
    description:
      'Search and paginate your accessible Sync projects. Each result includes recent generations and assets, so pass a small `limit` and use `searchQuery` only when the user explicitly refers to an existing project. Workflow names are not project references. Never choose the first match when names are ambiguous. Use the returned id as projectId in create-lipsync to work in the same project as the Sync web app.',
  },
  projects_get: {
    title: 'Get a project',
    description:
      'Get one accessible project by id. For its generation history, use projects_get-generations when available.',
  },
  projects_update: {
    description: "Update a project's name, description, visibility, or mode.",
  },
  projects_delete: {
    description:
      'Delete a project. Generations and assets attached to it are not deleted — they just stop being grouped under it.',
  },
};

export function getOverride(toolName: string): ToolOverride | undefined {
  return TOOL_OVERRIDES[toolName];
}
