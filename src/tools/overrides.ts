type ToolOverride = {
  description: string;
};

// Agent-friendly descriptions, keyed by generated tool name
// (operationIdToToolName). These encode the end-to-end workflow
// (discover models/voices → upload assets → tts → generate → poll) and tell the
// agent what to do next, so the tool list reads like a runbook. Endpoints
// without an entry fall back to the OpenAPI summary.
const TOOL_OVERRIDES: Record<string, ToolOverride> = {
  // --- Discovery ---
  models_get: {
    description:
      'List the lipsync models available to you (e.g. lipsync-2, lipsync-2-pro, sync-3, react-1). Use a returned model id as the `model` in generate_create-generation.',
  },
  'voices_get-voices': {
    description:
      'List available voices — premade ElevenLabs voices plus voices your org has cloned. For "make this image/video say X", use a returned voice `id` as `voiceId` in create-lipsync with `script` directly. Use tts_create only when the user explicitly asks for standalone audio.',
  },

  // --- Assets (upload + manage reusable media) ---
  'assets_create-upload-url': {
    description:
      'Upload step 1: get a presigned URL for a local file. PUT the raw bytes to the returned `uploadUrl` (same Content-Type), then register it with assets_create using the returned `url`. Use this when your media is not already at a public URL. Max 5GB.',
  },
  assets_create: {
    description:
      'Register a media URL as a reusable asset (e.g. the `url` from assets_create-upload-url, or any public URL). Returns an asset `id` to use as `input[].assetId` in a generation, or as a voice-clone sample.',
  },
  'assets_get-all': {
    description:
      'List assets (video/audio/image) in your organization. Use to find an existing assetId.',
  },
  assets_get: {
    description: 'Get one asset by id (details + URL).',
  },
  assets_update: {
    description: "Update an asset's name or visibility by id.",
  },
  assets_delete: {
    description: 'Delete an asset by id.',
  },

  // --- Voices (clone + manage) ---
  'voices_clone-voice': {
    description:
      'Clone a custom voice from an audio or video sample — pass a Sync-hosted `url` or an `assetId` (upload local files via assets_create-upload-url first), plus `provider` (elevenlabs) and a `name`. Returns a voice `id` for tts_create.',
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
      'Create a lipsync video. Provide a video input (or an image for sync-3) and an audio input, each by `url` or `assetId`. Returns a generation `id` — poll generate_get-generation until status is COMPLETED, then read `outputUrl`. To choose which face to sync in a multi-person video, pass `options.active_speaker_detection` (auto_detect, or coordinates + frame_number).',
  },
  'generate_get-generation': {
    description:
      'Get a generation by id and poll until status is COMPLETED; the result includes `outputUrl`. Supports waiting for terminal status.',
  },
  'generate_get-generations': {
    description:
      'List recent generations for your organization. Use to find generation ids or check status.',
  },
  'generate_estimate-cost': {
    description:
      'Estimate the credit cost of a generation before creating it. Takes the same body as generate_create-generation.',
  },
  'generations_get-by-id': {
    description:
      'Get a generation by id (organization-scoped). Returns status and, when COMPLETED, `outputUrl`.',
  },
  generations_delete: {
    description:
      'Delete a generation by id. Only terminal generations (COMPLETED/FAILED/REJECTED) can be deleted — deleting one that is still processing returns 409.',
  },
  'generations_estimate-cost': {
    description:
      'Estimate the credit cost of a generation before creating it. Returns estimated credits.',
  },

  // --- Projects (group generations + assets) ---
  projects_create: {
    description:
      'Create a project to group related generations and assets. Pass the returned `id` as `projectId` on generate_create-generation or assets_create so they show up together in Studio.',
  },
  'projects_get-all': {
    description: 'List the projects in your organization.',
  },
  projects_get: {
    description: 'Get a project by id.',
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
