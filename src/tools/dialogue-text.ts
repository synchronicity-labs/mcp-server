// Agent-facing text for the Edit Dialogue tools in dialogue.ts, kept here so that file
// stays readable. spend-confirmation.ts edits sentences of these descriptions by exact match.
export const DIALOGUE_TEXT = {
  'dialogue_get-options': {
    description:
      'Report which Edit Dialogue features this connection supports, as three booleans { available, keyedPreview, sourceUpload }. available is true whenever the dialogue tools are listed; keyedPreview is true when dialogue-previews_create accepts an idempotencyKey (sending one when it is false fails); sourceUpload is true when dialogue_upload-source can copy a saved video into sync. storage. The answer comes from the API spec this server loaded: the call is free, sends no request and is the same for every organization, so it does not check plan, credits or project access. Call it once before the first dialogue-previews_create to decide whether to persist an idempotencyKey. Not for lipsync models (models_list) or dubbing and voice options (dubbing_get-options, speech-previews_get-options).',
  },
  'dialogue_upload-source': {
    description:
      "Copy a saved VIDEO asset into sync. storage as a new VIDEO asset in the given project, for an Edit Dialogue source whose URL the API rejects as not hosted in sync. storage. Usually unnecessary: dialogue-transcriptions_create makes this copy itself on that rejection and returns the copy's videoAssetId, so call this only when you need the hosted copy before or without transcribing. Not for local files (assets_create-upload-url, then assets_create) or social links (assets_create). The server downloads and re-uploads the whole video during this call (server limits, 512 MiB and 15 minutes by default) and fails if the source cannot be downloaded or is too large. Each call writes another new asset with no deduplication; it does not change the original asset and spends no generation credits. Returns asset { id, type, url }: pass asset.id as videoAssetId to every later dialogue tool. Pass projectIntent=explicit with projectId only for the project just created for this request or one the user explicitly chose; a matching name, workflow or open editor is never permission.",
    params: {
      projectId:
        'Project the copy is saved in: the id projects_create returned for this request (defaultWorkflow edit_dialogue), or a project the user explicitly chose.',
      videoAssetId:
        'Saved VIDEO asset to copy, from assets_create or assets_list. Must be accessible to the connected account.',
    },
  },
  'dialogue-transcriptions_create': {
    description:
      "Start the unbilled timed-word transcription that begins Edit Dialogue: correcting or removing spoken words in a saved single-speaker video while keeping the original speaker voice. Not for general transcription or speaker analysis (transcriptions_create, when available), translation (dubbing_create, when available), or a new full script or different voice (explain the limit; use lipsync_create with a script only if the user asks for a new voice).\n\nReturns: the job's id, status, and once COMPLETED the transcript and speakerCount. Unless it is already COMPLETED, poll dialogue-transcriptions_get with the id; then, if speakerCount is 1, send the user's word edits to dialogue-previews_create.\n\nEffects: despite the destructive hint it overwrites nothing. It adds at most one transcription job, and none when it reuses one: for an identical source video in the organization the API returns its existing COMPLETED job, or one still running that started within the last hour. Only the copy fallback below adds an asset. It never changes the source, replaces dialogue or generates a video.\n\nLimits: the tool sets a 600-second ceiling, checked for a video after audio extraction, so a new job for a longer video still comes back and then ends FAILED with error.code SOURCE_TOO_LONG. HTTP 429 comes from the per-caller rate limit (10 a minute), the concurrency limit (2 at once per caller) or the organization's daily transcription cap; HTTP 402 means the account is on a payment or fraud hold.\n\nCopy fallback: if the API rejects the video as not hosted in sync. storage, the tool copies it to a new VIDEO asset in the project, retries, and adds the copy's id to the result as videoAssetId, which every later dialogue call must use. If that retry fails, the error names the saved copy to retry with; do not copy again.\n\nProject: projectIntent=explicit is required with projectId, and only for the project just created for this request or one the user explicitly asked for or selected in the interface; a matching name, workflow or open editor is never permission. Default new work to a new project.",
    params: {
      projectId:
        'Project for this Edit Dialogue work: the id projects_create returned for this request (defaultWorkflow edit_dialogue) or a project the user explicitly chose; pass projectIntent=explicit with either. The tool reads it first to confirm access, and the copy fallback saves into it. Keep it for every later dialogue call.',
      videoAssetId:
        'Saved VIDEO asset to transcribe that the account can read, from assets_create, assets_list or dialogue_upload-source. If the result returns videoAssetId, that sync.-hosted copy replaces this id for every later dialogue call.',
    },
  },
  'dialogue-transcriptions_get': {
    description:
      'Read one Edit Dialogue transcription job by id, the step between dialogue-transcriptions_create and dialogue-previews_create. It first confirms access to projectId and that the job was made from the stored video of videoAssetId; a job from any other source is rejected. Returns status: PENDING or PROCESSING while running, then COMPLETED or FAILED. Once COMPLETED: transcript.segments, each with words { id, text, startMs, endMs } in milliseconds from the start of the source, plus a top-level speakerCount (both are null before then). On FAILED: error { code, message }; NO_AUDIO, NO_AUDIO_TRACK and SOURCE_TOO_LONG will not succeed on retry. It has no wait option: call it again while the job runs, or, when available, use jobs_wait with kind transcription to wait on the server for up to about 50 seconds; never start another transcription to check progress. Word ids feed the edits of dialogue-previews_create, but Edit Dialogue supports one speaker, so do not create a preview when speakerCount is above 1. Not for jobs from the general transcriptions_create (read those with transcriptions_get, when available).',
    params: {
      projectId:
        'The projectId passed to dialogue-transcriptions_create. Used only to confirm project access; the job itself is read by id.',
      videoAssetId:
        "The videoAssetId passed to dialogue-transcriptions_create, or the copy's id when its result returned videoAssetId. It must be a VIDEO asset; its stored URL is compared with the job's source, and a job made from a different source video is rejected.",
      id: 'The id field of the dialogue-transcriptions_create result; later passed to dialogue-previews_create as transcriptionJobId.',
    },
  },
  'dialogue-previews_create': {
    description:
      "Start an Edit Dialogue audio preview: re-synthesize user-approved word changes and removals from a saved single-speaker video's transcript in the original speaker voice, returning the preview job (id, status). Not for translation (dubbing_create), another voice or a new full script (lipsync_create with a script, or speech-previews_create), or the final video (dialogue-videos_create). May clone the source speaker voice and incur synthesis charges; confirm the edits and permission to use that voice before creating. The tool first checks that the transcription (COMPLETED) or previous preview (COMPLETED or COMPLETED_PARTIAL) was made from this source video, and fails otherwise; it adds a preview job and never overwrites the source. Next, poll dialogue-previews_get with the id and disclose any COMPLETED_PARTIAL shortfall; after the user approves the audio, quote the final video with dialogue-videos_estimate. When dialogue_get-options reports keyedPreview, persist an idempotencyKey before creating (sending one otherwise fails); recover only through an explicit retry of identical input with that same key, and never retry an ambiguous creation automatically. With projectId, projectIntent=explicit is required; default new work to a new project.",
    params: {
      projectId:
        'Project for the preview, the one used for the transcription. Keep unchanged on retries. Default new work to a new project: the id projects_create returned for this request (defaultWorkflow edit_dialogue). Use an existing project only when the user explicitly chose it, and then pass projectIntent=explicit.',
      transcriptionJobId:
        'Id from dialogue-transcriptions_create, for a first preview; that transcription must be COMPLETED. Supply exactly one of transcriptionJobId or previousPreviewId.',
      previousPreviewId:
        'Id of a COMPLETED or COMPLETED_PARTIAL preview of this source, to revise it. Its sourceTranscript and cloned voice are reused, but its edits are not carried over, so edits must be the full set you want; sending the same edits again reruns it. Supply exactly one of previousPreviewId or transcriptionJobId.',
      edits:
        "The complete list of user-approved changes/removals for this preview (1 to 100), including earlier ones to keep when revising. Word ids come from the COMPLETED transcription's transcript, or from the previous preview's sourceTranscript, never its resultTranscript.",
    },
  },
  'dialogue-previews_get': {
    description:
      "Read one Edit Dialogue audio preview by id, rejecting it if it was not made from the given source video. Returns status (PENDING or PROCESSING while running; COMPLETED, COMPLETED_PARTIAL or FAILED when done), previewAudioUrl (hosted WAV of the whole edited window), resultTranscript (words retimed to the preview audio), resultSlots (each edited region's outputStartMs and outputDurationMs in the preview, sourceStartMs and sourceDurationMs in the source), the submitted sourceTranscript and edits, voiceId, partialDetail and error. Poll it while running; never create another preview to check progress. COMPLETED_PARTIAL is playable but incomplete: partialDetail.failedSlots lists regions that may sound rough, and reason background_bed_missing means only the speech was kept; tell the user which applies rather than reporting the preview as fully done. On FAILED, EDIT_TOO_LONG carries spanText and wordIds for the replacement to shorten, while codes such as VOICE_BLOCKED and SOURCE_TOO_LONG will not succeed on retry. Once the user approves the audio, pass this id as dialogueEditId to dialogue-videos_estimate and dialogue-videos_create; to revise, call dialogue-previews_create with previousPreviewId. Not for rendered videos (generations_get).",
    params: {
      projectId: 'The projectId used with dialogue-previews_create.',
      videoAssetId:
        "The videoAssetId used to create this preview (the copy's id if dialogue-transcriptions_create returned one). A preview made from a different source video is rejected.",
      id: 'The id returned by dialogue-previews_create.',
    },
  },
  'dialogue-videos_estimate': {
    description:
      'Quote the final lipsynced Edit Dialogue video for a finished preview without charging: returns estimatedGenerationCost in US dollars, estimatedCredits (1 credit = $0.01; null when the organization is billed in dollars), estimatedFrameCount and, when present, durationCheck (whether the plan and model allow that length). Call it before dialogue-videos_create with the same projectId, videoAssetId, dialogueEditId, model, options and organizationId, and show the user the quote; it holds only for that model and options. Not for other workflows (generations_estimate-cost) or what a past generation actually cost (generations_get-costs). It checks project and source access but creates no job, reserves no credits and does not guarantee admission. The API rejects a preview that is missing or not COMPLETED or COMPLETED_PARTIAL, and returns 422 cost_estimate_unavailable when the source duration cannot be resolved.',
    params: {
      dialogueEditId:
        'Id of the COMPLETED or COMPLETED_PARTIAL preview from dialogue-previews_create that the user approved; not a transcription or generation id.',
      model:
        'Lipsync model name from models_list, such as sync-3. Use the same model on dialogue-videos_create.',
    },
  },
  'dialogue-videos_create': {
    description:
      "Render the final Edit Dialogue video: lipsync the saved single-speaker source video to a finished, user-approved preview's audio, creating a new generation. Not for translation (dubbing_create), whole-script replacement or a different voice (lipsync_create with a script), or the audio preview itself (dialogue-previews_create). This is a paid action that starts a generation job and consumes sync. credits. First use dialogue-videos_estimate with the same source, preview and model, then obtain the user's approval of the preview, configuration and estimated cost. Despite the destructive hint it only adds a generation and never overwrites the source video. Returns the generation (id, status) right away, not a finished video; poll generations_get, or jobs_wait with kind generation when available,, then read outputMediaUrl when COMPLETED. Persist one idempotencyKey for the approved request; on an uncertain response, reuse that key with identical inputs instead of starting a second paid job. Use continuation only for an explicitly requested continuation of an edit_dialogue generation in this project. With projectId, projectIntent=explicit is required; default new work to a new project.",
    params: {
      projectId:
        'Project for the new output, the one used for the preview. Keep unchanged on retries. Default new work to a new project: the id projects_create returned for this request (defaultWorkflow edit_dialogue). Use an existing project only when the user explicitly chose it, and then pass projectIntent=explicit.',
    },
  },
} as const;
