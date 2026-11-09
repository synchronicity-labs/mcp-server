import { ASSET_PROJECT_OVERRIDES, type ToolOverride } from './asset-overrides.js';
import { GENERATION_OVERRIDES } from './generation-overrides.js';

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
      "Read which face in the video belongs to each transcript speaker of a COMPLETED video transcription, by transcription id. Read-only: video transcriptions of your own media are usually analysed automatically, and transcriptions_analyze-speakers starts or retries an analysis only when this returns unavailable with reason not_requested, analysis_failed or analysis_timeout.\nReturns status (processing, completed or unavailable), the revision that transcriptions_slice-speaker-face-track needs, and speakers: each matched (with an avatar, the evidence and a faceTrack whose url is a public JSON file with one box per frame of the source file where that face is visible) or uncertain (with a reason). Other unavailable reasons do not call for analyze-speakers: retry_limit means the attempts are used up, and reasons such as source_binding_unavailable (an audio-only source or one outside your organization's storage), source_too_long or too_many_speakers rule the source out.\nwait: true waits for the analysis, not the transcription; jobs_wait with kind speaker_analysis, when available, waits on the same analysis.\nNext step for lipsync_create-timeline: cut each matched speaker's track per clip with transcriptions_slice-speaker-face-track. Clips of an uncertain speaker use speaker detect instead, or lipsync: false where the timeline tool offers that field.",
    params: {
      id: TRANSCRIPTION_ID,
      wait: 'Wait on the server while the analysis status is processing, for up to about 50 seconds, then return its latest state; if still processing, call again with wait: true instead of sleeping. Does not wait for an unfinished transcription, which returns 409.',
    },
  },
  'transcriptions_analyze-speakers': {
    title: 'Match speakers to faces',
    description:
      "Run, or retry, the speaker-to-face match for a COMPLETED video transcription and return the analysis in the same shape as transcriptions_get-speaker-analysis. Read transcriptions_get-speaker-analysis first: video transcriptions of your own media are usually analysed automatically. Call this only when that read says unavailable with reason not_requested, or with retry: true after a failed or timed-out attempt (analysis_failed, analysis_timeout). Not for audio-only transcriptions, windows longer than 2 minutes or more than 8 speakers: those return unavailable with a reason instead of running. A completed or still-running analysis is returned unchanged, even with retry; a new attempt overwrites the previous failed result, and a transcription gets at most 3 attempts including the automatic one (then retry_limit). Free; 3 calls a minute. The analysis runs inside the request and can take minutes; if this call times out the analysis keeps going, so read it with transcriptions_get-speaker-analysis and wait: true rather than calling again. A stale revision or unfinished transcript is a 409 error, and a sourceVideoUrl that is not the transcription's own video is a 422.",
    params: {
      id: TRANSCRIPTION_ID,
      revision:
        "The transcription's revision from transcriptions_get (a 64-character hex string, present once COMPLETED). A stale one fails with 409.",
      sourceVideoUrl:
        "The transcription's sourceVideoUrl from transcriptions_get, unchanged; any other video is refused with 422.",
      retry:
        'true to start a new attempt after a failed or timed-out one. Omit for a first analysis. Ignored while an analysis is completed or still running.',
    },
  },
  'transcriptions_slice-speaker-face-track': {
    title: "Cut a clip's face track",
    description:
      "Cut one matched speaker's face track to the frames of one lipsync_create-timeline clip and return {url}: a public JSON file of per-frame face boxes to pass as that clip's speaker.faceTrackUrl, so the clip lipsyncs exactly that person. Use it after transcriptions_get-speaker-analysis reports the speaker matched; not for uncertain speakers (a 422 error), whose clips use speaker detect or a point on the face instead.\nFrames are [startFrame, endFrame) counted from the first frame of the source file, not of the transcription window, and the track is resampled by time onto your fps.\nEach call writes a new file and returns a new url; it is free, 60 calls a minute. url is null, and no file is written, when the face is on none of those frames: use detect for that clip, or keep it unlipsynced with lipsync: false where lipsync_create-timeline offers that field. A changed transcript revision is a 409 error: read the analysis again.",
    params: {
      id: TRANSCRIPTION_ID,
      revision: SPEAKER_ANALYSIS_REVISION,
      speakerId: 'A matched speaker id from transcriptions_get-speaker-analysis.',
      startFrame:
        "First frame of the clip, inclusive, counted from the first frame of the source file: the timeline clip's startFrame.",
      endFrame: 'Frame after the clip ends (exclusive): the timeline clip endFrame + 1.',
      fps: 'Frame rate of the video the timeline lipsyncs, as assets_get-playback-metadata reports it; the face track is resampled by time onto this grid.',
      skip: 'Optional range { startFrame, endFrame } (end exclusive) strictly inside the clip that a cut removed from its footage. Those frames are left out of the file, so it keeps one box per remaining frame. Usually omitted.',
    },
  },
  transcriptions_create: {
    title: 'Transcribe a video',
    description:
      'Start a word-level transcription of a video or audio source and return its job id and status. Use it for general transcription, speaker analysis or timeline lipsync; for Edit Dialogue use dialogue-transcriptions_create when available. Read the result with transcriptions_get, or jobs_wait with kind transcription when available.',
  },
  transcriptions_get: {
    title: 'Read a transcription',
    description:
      'Read one transcription job by id. Returns:\n- status: PENDING, PROCESSING, COMPLETED or FAILED.\n- Once COMPLETED, transcript.segments, each with an id and words. A word has text, startMs and endMs in milliseconds from the start of the source (not of the transcribed window), and a speakerId that is null or absent when unknown.\n- speakerCount, a top-level field beside transcript.\n- revision (once there is a transcript) and sourceVideoUrl (null for an audio source), which transcriptions_analyze-speakers takes.\n- On FAILED, error.code. NO_AUDIO, NO_AUDIO_TRACK and SOURCE_TOO_LONG will not succeed on retry.\n- While running, estimate.estimatedFinishAt may give an expected finish. estimate is null or absent when there is too little history.\nUse it after transcriptions_create. id is the UUID that call returned: a malformed id is a 400 error, and a well-formed id not in the current organization is a 404. With wait: true the server keeps reading for up to about 50 seconds and returns once the job is COMPLETED or FAILED. If it is still running, call again with wait: true; never start another transcription to check progress.\nNot for Edit Dialogue transcriptions (dialogue-transcriptions_get, when available) or face matches (transcriptions_get-speaker-analysis). jobs_get and jobs_wait with kind transcription, when available, read the same job with the cross-kind statuses.',
    params: { id: TRANSCRIPTION_ID },
  },
  // --- Discovery ---
  models_list: {
    title: 'List Sync models',
    description:
      'List the sync. models this account can see, newest first, in one unpaged array; each has name, type, version, description and feature tags. Use it to choose or check the model name that dubbing_create, dialogue-videos_create, dialogue-videos_estimate and generations_estimate-cost require, or to override the sync-3 default of lipsync_create and lipsync_create-timeline; it is not needed when the user has not asked for a model on those two. Pass a returned name exactly as listed and never invent one. Deprecated models are left out and feature-flagged ones appear only where enabled, but a listed model can still be refused at creation, such as react-1 for an organization without a paid plan. Some models serve other workflows, such as appearance editing; for lip sync pick a lipsync model. Not for voices; use voices_list.',
  },
  voices_list: {
    title: 'List voices',
    description:
      'List the text-to-speech voices this organization can use: premade ElevenLabs voices plus voices it has cloned, each with id, name, provider, previewUrl and restriction. Use it when speech comes from a script: for "make this image/video say X", pass a returned id (not the provider voiceId) as voiceId to lipsync_create with script, or to speech-previews_create. Check it for an existing clone before cloning a voice again. A voice whose restriction is set cannot synthesize speech; choose another. Not for lipsync models; use models_list. Read-only.',
    params: {
      provider:
        'Return only voices from this provider. Only elevenlabs is accepted; omit to list every voice.',
    },
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
};

export function getOverride(toolName: string): ToolOverride | undefined {
  return (
    TOOL_OVERRIDES[toolName] ?? GENERATION_OVERRIDES[toolName] ?? ASSET_PROJECT_OVERRIDES[toolName]
  );
}
