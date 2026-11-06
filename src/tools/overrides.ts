import type { z } from 'zod';
import { ASSET_THUMBNAIL_INSTRUCTIONS } from '../asset-thumbnail.js';
import { generationDtoOutputSchema, generationOutputSchema } from './output-schemas.js';

type ToolOverride = {
  title?: string;
  /** Replaces the OpenAPI summary. */
  description?: string;
  outputSchema?: Record<string, z.ZodType>;
  /** Input descriptions by parameter name; they replace the spec's text. */
  params?: Record<string, string>;
};

const ASSET_FILTERS = {
  projectId: 'Only assets attached to this project (an id from projects_list or projects_create).',
  userId: 'Only assets created by this user id.',
  sortBy: 'Sort order, such as dateDesc for newest first.',
  types: 'Only these media types: VIDEO, AUDIO or IMAGE, as one value or a list.',
};

const ASSET_METADATA = {
  durationSeconds: 'Media length in seconds, when known.',
  size: 'File size in bytes, when known.',
  format: 'File format or extension, such as mp4 or wav, when known.',
  width: 'Video or image width in pixels, when known.',
  height: 'Video or image height in pixels, when known.',
};

const TRANSCRIPTION_ID = 'Transcription id from transcriptions_create.';
const SPEAKER_ANALYSIS_REVISION =
  'The revision returned by transcriptions_get-speaker-analysis, so the call matches that analysis.';

const SPEECH_PARAMS = {
  script: 'Text to speak.',
  voiceId: 'Voice id from voices_list.',
  provider: 'Speech provider. Only elevenlabs is supported.',
  stability: 'Voice consistency from 0 to 1; higher is steadier, lower is more expressive.',
  similarityBoost: 'How closely to match the original voice, from 0 to 1.',
};

const ESTIMATE_PARAMS = {
  model: 'Model name from models_list, such as sync-3.',
  reasoningEnabled: 'Quote with reasoning on. Only lipsync-2-pro supports it.',
};

const PROJECT_FIELDS = {
  name: 'Project name shown in Studio.',
  description: 'Optional project notes.',
};

// Agent-friendly descriptions, keyed by generated tool name
// (operationIdToToolName). These encode the end-to-end workflow
// (discover models/voices → upload assets → tts → generate → poll) and tell the
// agent what to do next, so the tool list reads like a runbook. Endpoints
// without an entry fall back to the OpenAPI summary.
const TOOL_OVERRIDES: Record<string, ToolOverride> = {
  // --- Speakers to faces (timeline lipsync) ---
  'transcriptions_get-speaker-analysis': {
    title: 'Read which face belongs to each speaker',
    description:
      'Read which face in the video belongs to each transcript speaker, by transcription id. Video transcriptions of your own media are analysed automatically; pass wait: true while status is processing. Each speaker is matched (with an avatar, the evidence and a faceTrack: one box per frame of the file where that face is visible) or uncertain (with a reason). To lipsync only the people talking on camera, give each lipsync_create-timeline clip of a matched speaker the url from transcriptions_slice-speaker-face-track as speaker.faceTrackUrl, and keep (lipsync: false, when available) clips of uncertain speakers or where the slice url is null.',
    params: { id: TRANSCRIPTION_ID },
  },
  'transcriptions_analyze-speakers': {
    title: 'Match speakers to faces',
    description:
      "Start, or retry, the speaker-to-face analysis for a completed video transcription. Pass the transcription's revision and sourceVideoUrl from transcriptions_get. Read transcriptions_get-speaker-analysis first: it usually already exists. Unbilled; up to 2 minutes of video and 8 speakers; 3 calls a minute.",
    params: {
      id: TRANSCRIPTION_ID,
      revision: "The transcription's revision from transcriptions_get.",
      sourceVideoUrl: "The transcription's sourceVideoUrl from transcriptions_get.",
      retry: 'true to run the analysis again for this revision.',
    },
  },
  'transcriptions_slice-speaker-face-track': {
    title: "Cut a clip's face track",
    description:
      "Cut a matched speaker's face track to one clip and get a url for lipsync_create-timeline speaker.faceTrackUrl, so that clip lipsyncs exactly that person. Frames are [startFrame, endFrame) at the video's fps: for a timeline clip pass its startFrame and endFrame + 1. url is null when the face is on none of those frames; keep that clip (lipsync: false) or use detect.",
    params: {
      id: TRANSCRIPTION_ID,
      revision: SPEAKER_ANALYSIS_REVISION,
      speakerId: 'A matched speaker id from transcriptions_get-speaker-analysis.',
      startFrame: 'First frame of the clip, inclusive.',
      endFrame: 'Frame after the clip ends (exclusive): the timeline clip endFrame + 1.',
      fps: "The source video's frame rate.",
      skip: 'Optional frame range inside the clip, { startFrame, endFrame }, to leave without boxes.',
    },
  },
  transcriptions_create: {
    title: 'Transcribe a video',
    description:
      'Start a word-level transcription of a video or audio source and return its job id and status. Use it before Edit Dialogue, speaker analysis or timeline lipsync; read the result with transcriptions_get, or jobs_wait with kind transcription.',
  },
  transcriptions_get: {
    title: 'Read a transcription',
    description:
      'Read one transcription job by id: its status, the word-level transcript with millisecond timings and speakers once COMPLETED, and the revision and sourceVideoUrl that speaker analysis needs. jobs_get and jobs_wait read the same job by kind transcription.',
    params: { id: TRANSCRIPTION_ID },
  },
  // --- Discovery ---
  models_list: {
    title: 'List Sync models',
    description:
      'List Sync models with their type, features and deprecation status. Some listed models serve other workflows, such as appearance editing; use only a non-deprecated lipsync model in lipsync_create. Use a returned model name as-is; do not invent model names.',
  },
  voices_list: {
    title: 'List voices',
    description:
      'List available voices: premade ElevenLabs voices plus voices your org has cloned. For "make this image/video say X", use an available returned voice `id` as `voiceId` in lipsync_create with `script` directly. Respect any returned restriction. Use this to find an existing clone before creating another.',
    params: { provider: 'Only voices from this provider. Only elevenlabs is supported.' },
  },

  // --- Assets (upload + manage reusable media) ---
  'assets_create-upload-url': {
    title: 'Get a media upload URL',
    description:
      'Upload step 1: get a presigned URL for a local file. PUT the raw bytes to the returned `uploadUrl` (same Content-Type), then register it with assets_create using the returned `url`. Use this when your media is not already at a public URL. Max 5GB.',
    params: {
      fileName: 'Name of the local file, with its extension.',
      contentType: 'MIME type of the file, such as video/mp4; send the same value when you PUT it.',
      size: 'File size in bytes.',
    },
  },
  assets_create: {
    title: 'Register a media asset',
    description:
      'Register a direct media URL or import a YouTube, TikTok, Instagram or Facebook video link as a reusable asset. For a social link, pass url, type=VIDEO and the selected projectId. A 409 import_in_progress means the download is running: wait retryAfterMs (15 seconds if absent), then repeat this exact request with the same URL and project. The API reuses the import and returns its saved VIDEO asset when ready. Never use importJobId as an asset ID. Stop on import_failed, import_not_enabled, import_unavailable or import limits and explain the error; do not automatically restart. Returns an asset id for generation inputs or videoAssetId in dubbing_create when available. Import first, then estimate and confirm translation. Link imports have daily limits.',
    params: {
      url: 'Media URL: the url assets_create-upload-url returned, a public https:// file, or a YouTube, TikTok, Instagram or Facebook video link.',
      type: 'Media type: VIDEO, AUDIO or IMAGE.',
      name: 'Display name for the asset.',
      projectId: 'Project to attach the asset to, from projects_create or projects_list.',
      visibility: 'USER keeps it private to you; ORGANIZATION shares it with your team.',
      inputType: 'How the media was produced, such as UPLOAD or URL. Usually omitted.',
      thumbnailUrl: 'Optional preview image URL for the asset.',
      contentSha256: 'Optional SHA-256 hex digest of the file.',
      ...ASSET_METADATA,
    },
  },
  assets_list: {
    title: 'List assets',
    description:
      'List assets (video/audio/image) in your organization. Use to find an existing assetId. Pass a small `limit` and narrow with `searchQuery`, `types` or `projectId`. ' +
      ASSET_THUMBNAIL_INSTRUCTIONS,
    params: ASSET_FILTERS,
  },
  assets_get: {
    title: 'Get an asset',
    description:
      'Get one asset by id: its type, name, media url, duration, size, dimensions and thumbnailUrl. For a signed download link use assets_get-download-url; for playback details use assets_get-playback-metadata when available. ' +
      ASSET_THUMBNAIL_INSTRUCTIONS,
    params: { id: 'Asset id from assets_list or assets_create.' },
  },
  assets_update: {
    title: 'Update an asset',
    description:
      'Rename an asset or change its visibility by id. Change only what the user asked for.',
    params: {
      id: 'Asset id from assets_list or assets_create.',
      name: 'New display name.',
      visibility: 'USER keeps it private to you; ORGANIZATION shares it with your team.',
      ...ASSET_METADATA,
    },
  },
  assets_delete: {
    title: 'Delete an asset',
    description:
      'Delete an asset by id. Use only on an explicit user request, after confirming which asset.',
    params: { id: 'Asset id from assets_list or assets_create.' },
  },
  assets_count: {
    title: 'Count assets',
    description:
      'Count the assets that match the same filters as assets_list (project, creator, search text, type) and return the number, not the assets. Use it to report a total; use assets_list to see or pick assets.',
    params: { ...ASSET_FILTERS, limit: 'Ignored when counting.', cursor: 'Ignored when counting.' },
  },
  'assets_get-download-url': {
    title: 'Get an asset download URL',
    description:
      "Get a signed download URL for one asset's media file. Use it to download the file; use assets_get for the asset's details. Return the URL exactly as given; signed URLs must not be edited.",
    params: { id: 'Asset id from assets_list or assets_create.' },
  },

  // --- Voices (clone + manage) ---
  voices_clone: {
    title: 'Clone a voice',
    description:
      'Use this when the user explicitly wants to save a reusable clone of their own voice or a voice they have permission to clone. Confirm the sample and name first; plan limits and provider requirements apply, so do not claim this is free. Pass exactly one of a Sync-hosted `url`, accessible `assetId`, or `sampleUrls` (up to 10 Sync-hosted samples), plus `provider` (elevenlabs) and `name`. Upload/register local samples first. Video samples have audio extracted by the API. Returns a Sync `id`: use that id as `voiceId` in lipsync_create with script, not the provider-specific `voiceId` field. Do not use for Edit Dialogue previews, selecting an existing voice, or designing a voice from a text description. This creates a persistent voice and is not idempotent. On timeout or uncertain failure, list voices and reconcile; never automatically retry. Surface API plan limits, sample errors and duplicate-name errors without retrying or changing accounts.',
    params: {
      name: 'Name for the cloned voice, unique in your organization.',
      provider: 'Voice provider. Only elevenlabs is supported.',
    },
  },
  voices_delete: {
    description: 'Delete a cloned voice by id, freeing a clone slot.',
    params: { id: 'Cloned voice id from voices_list.' },
  },
  voices_get: {
    description: 'Get one voice by id: its name, provider, preview URL and any usage restriction.',
    params: {
      id: 'Voice id from voices_list: a premade provider id or a cloned voice UUID.',
      provider: 'Voice provider. Only elevenlabs is supported.',
    },
  },

  // --- Text-to-speech ---
  tts_create: {
    description:
      'Synthesize standalone speech audio from text. Use only when the user specifically asks for an audio file or voice preview. Do not use this for "make this image/video say X" lipsync requests; use lipsync_create with `script` and `voiceId` directly.',
    params: SPEECH_PARAMS,
  },
  'tts-jobs_create': {
    description:
      'Start an asynchronous speech synthesis job from text and return its job id. Use only when the user asks for a standalone audio file; for "make this image/video say X", use lipsync_create with `script` and `voiceId`. Read it with tts-jobs_get.',
    params: SPEECH_PARAMS,
  },
  'tts-jobs_get': {
    description:
      'Read one speech synthesis job by id: its status, and the audio url and duration once it finishes, or its error.',
    params: { id: 'Job id from tts-jobs_create.' },
  },

  // --- Generate + poll ---
  generations_create: {
    description:
      'Create a lipsync video. Provide a video input (or an image for sync-3) and an audio input, each by `url` or `assetId`. Returns a generation `id`; call generations_get with `wait: true` and omit `timeout` to use the API default. If still pending, poll the same id; when completed, read `outputMediaUrl` (`outputUrl` is a deprecated alias). To choose which face to sync in a multi-person video, pass `options.active_speaker_detection` (auto_detect, or coordinates + frame_number).',
    outputSchema: generationOutputSchema,
  },
  generations_get: {
    title: 'Get a generation',
    description:
      'Get a generation by id. Pass `wait: true` and omit `timeout` to use the API default. If still pending, poll the same generation id again; never resubmit the generation. When status is COMPLETED, copy the exact `structuredContent.outputMediaUrl` string verbatim; signed URLs must not be reconstructed, shortened, or edited. `outputUrl` is a deprecated alias with the same value.',
    outputSchema: generationOutputSchema,
  },
  generations_list: {
    title: 'List generations',
    description:
      'List recent generations for your organization to find generation ids or check status. Pass a small `limit`, or narrow with its filters; for the history of one project, prefer projects_list-generations when available.',
  },
  'generations_estimate-cost': {
    title: 'Estimate generation cost',
    description:
      'Estimate Sync cost before generating. For replacement speech, supply model and script (approximate spoken duration), or audioDuration (measured seconds once audio exists). These override duration; do not quote the full source video length for a shorter replacement script. For video cut_off or silence supply videoDuration and the selected syncMode; for images set visualType=image and omit videoDuration. Otherwise supply billable output duration in seconds, optional fps and reasoningEnabled. Explain returned durationEstimate, label script estimates approximate, and disclose that speech synthesis is excluded. If the schema supports workflow=translate-and-dub, use it for both stages and show the returned breakdown; disclose excluded external provider charges. Otherwise this prices lip-sync only. Does not create jobs or reserve credits.',
    params: ESTIMATE_PARAMS,
  },
  'generations_get-details': {
    description:
      'Get a generation by id (organization-scoped). Returns status and, when COMPLETED, `outputMediaUrl` (`outputUrl` is a deprecated alias).',
    outputSchema: generationDtoOutputSchema,
  },
  generations_delete: {
    description:
      'Delete a generation by id. Only terminal generations (COMPLETED/FAILED/REJECTED) can be deleted; deleting one that is still processing returns 409.',
    params: { id: 'Generation id from generations_list or a create tool.' },
  },
  generations_estimate: {
    description:
      'Estimate generation cost before creating it. For replacement speech supply script for an approximate spoken-duration quote, or measured audioDuration once audio exists, instead of source video duration. For video cut_off or silence supply videoDuration and the selected syncMode; for images set visualType=image and omit videoDuration. Explain returned durationEstimate; speech synthesis is excluded. For translate-and-dub use source duration and disclose excluded external provider charges.',
    params: ESTIMATE_PARAMS,
  },

  // --- Projects (group generations + assets) ---
  projects_create: {
    title: 'Create a project',
    description:
      'Create a project to group related generations and assets. Pass the returned `id` as `projectId` to lipsync_create or assets_create so they show up together in Studio. Use by default for a new workflow request, even if an existing project has the same name. Supply a fresh UUID id and preserve it on retries. Project names never select existing work.',
    params: PROJECT_FIELDS,
  },
  projects_list: {
    title: 'List projects',
    description:
      'List your accessible Sync projects with their recent generations and assets, as items plus nextCursor. Pass a small `limit`, and use `searchQuery` only when the user refers to an existing project by name; workflow names are not project references, and never pick the first of several matches. Use the returned id as projectId to work in that project; use projects_get for one known project.',
    params: {
      sortBy: 'Sort by updatedAt or name.',
      searchQuery: 'Text to match against project names.',
    },
  },
  projects_get: {
    title: 'Get a project',
    description:
      "Get one accessible project by id: its name, description, visibility, mode, default workflow and recent generations. Use it when you already have the project's id; to find one, use projects_list. For its full generation history, use projects_list-generations when available.",
  },
  projects_update: {
    description: "Update a project's name, description, visibility, or mode.",
    params: {
      ...PROJECT_FIELDS,
      visibility: 'USER keeps it private to you; ORGANIZATION shares it with your team.',
      mode: 'CREATOR or DEVELOPER.',
    },
  },
  'projects_attach-asset': {
    params: { assetId: 'Asset id from assets_list or assets_create to attach to the project.' },
  },
  'assets_get-many': {
    params: { ids: 'Asset ids from assets_list or assets_create.' },
  },
  generations_count: {
    params: {
      status: 'Only generations in these statuses, such as COMPLETED or FAILED.',
      type: 'playground for Studio generations or api for API generations.',
      source: 'Only generations from these sources.',
      generationSource: 'Only generations started from this surface, such as mcp, chatgpt or api.',
      currentUserOnly: 'true to count only your own generations.',
    },
  },
  'generations_update-output-file-name': {
    params: {
      id: 'Generation id from generations_list or a create tool.',
      outputFileName: 'New file name for the generated output, up to 255 characters.',
    },
  },
  projects_delete: {
    description:
      'Delete a project. Generations and assets attached to it are not deleted; they just stop being grouped under it.',
  },
};

export function getOverride(toolName: string): ToolOverride | undefined {
  return TOOL_OVERRIDES[toolName];
}
