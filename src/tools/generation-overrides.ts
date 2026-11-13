import type { ToolOverride } from './asset-overrides.js';
import { WAIT_DESCRIPTION } from './job-wait.js';
import {
  generationDtoOutputSchema,
  generationOutputSchema,
  generationReadOutputSchema,
} from './output-schemas.js';

const GENERATION_ID = 'Generation id returned by a create tool or generations_list.';

const ESTIMATE_PARAMS = {
  model: 'Model name from models_list, such as sync-3.',
  reasoningEnabled: 'Quote with reasoning on. Only lipsync-2-pro supports it.',
};

/** Overrides for the generate and poll tools, keyed by generated tool name. */
export const GENERATION_OVERRIDES: Record<string, ToolOverride> = {
  generations_create: {
    description:
      'Create a lipsync video. Provide a video input (or an image for sync-3) and an audio input, each by `url` or `assetId`. Returns a generation `id`; call generations_get with `wait: true` and omit `timeout` to use the API default. If still pending, poll the same id; when completed, read `outputMediaUrl` (`outputUrl` is a deprecated alias). To choose which face to sync in a multi-person video, pass `options.active_speaker_detection` (auto_detect, or coordinates + frame_number).',
    outputSchema: generationOutputSchema,
  },
  generations_get: {
    title: 'Get a generation',
    description:
      'Read one sync. generation by id: its status (PENDING or PROCESSING while it runs; COMPLETED, FAILED or REJECTED when final), outputMediaUrl once COMPLETED, and error and errorCode after FAILED or REJECTED.\n' +
      'Use it to follow a generation by the id its create call returned (lipsync_create, dubbing_create, lipsync_create-timeline or dialogue-videos_create, when available). jobs_get and jobs_wait, when available, read the same generation in a generic job shape that can add a completion percent while it runs.\n' +
      'Not for: finding a past id (generations_list, or projects_list-generations when available); what it cost (generations_get-costs when available); its inputs when the user explicitly continues it (generations_get-continuation).\n' +
      'Waiting: pass `wait: true` and leave out `timeout` to keep reading on the server for up to about 50 seconds; it returns once the generation is final, or its latest state. If it is still running, call again with the same id; never resubmit, since a new create starts a separate generation that is billed or counted against free limits.\n' +
      'Result: copy the exact `structuredContent.outputMediaUrl` string verbatim; it is signed, so it must not be reconstructed, shortened, or edited (`outputUrl` is a deprecated alias with the same value). On FAILED or REJECTED, tell the user the error and errorCode.',
    outputSchema: generationReadOutputSchema,
    params: {
      id: GENERATION_ID,
      wait: WAIT_DESCRIPTION,
      timeout:
        'Seconds each read holds (1-10). Leave it out; wait: true reads for about 50 seconds.',
    },
  },
  generations_list: {
    title: 'List generations',
    description:
      'List generations across the current sync. organization, from every member and API key, to find a generation id or see which are still running. For one known id use generations_get. Pass projectId to narrow to one project; projects_list-generations, when available, does the same but fails on a project you cannot access, while this tool returns an empty list. Always pass limit to get newest first; without it every matching generation comes back unpaged in no guaranteed order. For the next page pass the last returned id as cursor with the same limit. Each entry has id, status, model, createdAt, projectId, input, options, outputMediaUrl once COMPLETED, and error and errorCode on failure.',
    params: {
      projectId: 'Only generations in this project, from projects_list or projects_create.',
      status:
        'Only generations in this status: PENDING, PROCESSING, COMPLETED, FAILED or REJECTED. PENDING (queued) and PROCESSING both mean still running, so check both before concluding nothing is in progress.',
    },
  },
  'generations_estimate-cost': {
    title: 'Estimate generation cost',
    description:
      'Estimate a lipsync, image-to-video or translate-and-dub generation and check duration eligibility; creates no job and reserves no credits. Use it before lipsync_create or dubbing_create, and price one representative item before batches_create. The base-rate estimate can be nonzero for a free account: read account_get-usage to check coverage and, when the whole request is covered, do not mention prices or request spending confirmation. Not for what a past generation cost (generations_get-costs, when available), the final Edit Dialogue video (dialogue-videos_estimate) or a translated-audio preview (translation-previews_estimate). Give one length: duration, or for replacement speech script or measured audioDuration, which replace duration; never quote the full source video length for a shorter replacement script. Without workflow=translate-and-dub the quote covers lipsync only, never the full translation workflow. Returns estimatedGenerationCost in USD, estimatedCredits for credit-billed organizations (null otherwise), estimatedFrameCount, durationCheck (whether that length fits the plan and model limits; a price does not guarantee admission), breakdown for translate-and-dub, and durationEstimate for script or audio quotes. When presenting a paid or unknown-coverage quote, explain durationEstimate, label script quotes approximate, show the breakdown, and disclose that speech synthesis and external provider charges are excluded.',
    params: {
      ...ESTIMATE_PARAMS,
      model:
        'Model name from models_list, such as sync-3; use the same model the create call will use.',
      workflow:
        'translate-and-dub prices dubbing plus lipsync from the source duration in duration, and returns a breakdown with external provider charges excluded; it rejects script and audioDuration. Omit for lipsync only.',
    },
  },
  'generations_get-details': {
    description:
      'Get a generation by id (organization-scoped). Returns status and, when COMPLETED, `outputMediaUrl` (`outputUrl` is a deprecated alias).',
    outputSchema: generationDtoOutputSchema,
    params: { id: GENERATION_ID },
  },
  generations_delete: {
    description:
      'Delete a generation by id. Only terminal generations (COMPLETED/FAILED/REJECTED) can be deleted; deleting one that is still processing returns 409.',
    params: { id: GENERATION_ID },
  },
  generations_estimate: {
    description:
      'Estimate generation cost before creating it. For replacement speech supply script for an approximate spoken-duration quote, or measured audioDuration once audio exists, instead of source video duration. For video cut_off or silence supply videoDuration and the selected syncMode; for images set visualType=image and omit videoDuration. Explain returned durationEstimate; speech synthesis is excluded. For translate-and-dub use source duration and disclose excluded external provider charges.',
    params: ESTIMATE_PARAMS,
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
      id: GENERATION_ID,
      outputFileName: 'New file name for the generated output, up to 255 characters.',
    },
  },
};
