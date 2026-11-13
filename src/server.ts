import type {
  CallToolResult,
  ReadResourceResult,
  Resource,
  Tool,
} from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  isFeatureGatedTool,
  listedForAccount,
  withoutGatedParameters,
} from './account-features.js';
import { relayUploadTool } from './app-upload-relay.js';
import { ASSET_THUMBNAIL_INSTRUCTIONS } from './asset-thumbnail.js';
import { createApiKeyAuth } from './auth/api-key.js';
import { performDeviceAuth } from './auth/device-auth.js';
import { emailLoginAuth, savedEmailLogin } from './auth/email-code-login.js';
import { resourceMetadataUrl } from './auth/resource-metadata.js';
import { loadToken } from './auth/token-store.js';
import {
  CARD_RESOURCE_NAMES,
  CARD_TOOL_NAMES,
  cardMeta,
  cardResources,
  createCardTools,
  withCard,
} from './cards.js';
import {
  createAnalyticsTool,
  toolAnalyticsSupport,
  trackToolExecution,
  uiAnalyticsSchema,
} from './chatgpt-analytics.js';
import { type ChatgptApp, createOpenSyncAppTool, loadChatgptAppReleases } from './chatgpt-app.js';
import {
  type ClientProfile,
  resolveClientProfile,
  UNSUPPORTED_UPLOAD_MESSAGE,
} from './client-profile.js';
import type { SyncMcpConfig } from './config.js';
import { GENERATION_STATUS_HTML } from './generation-status-html.js';
import {
  generationStatusMetadata,
  GENERATION_STATUS_URI,
  withGenerationStatusCard,
  withStatusCardTool,
} from './generation-status.js';
import {
  type ApiErrorDetails,
  ApiRequestError,
  type AuthSource,
  cameFromApi,
  createHttpClient,
} from './http-client.js';
import { errorFields } from './log-redaction.js';
import { fetchSpec } from './openapi/fetcher.js';
import { parseSpec } from './openapi/parser.js';
import {
  currentOrganizationSession,
  OrganizationSession,
  type OrganizationSummary,
  type RanIn,
  runInOrganization,
  runInOrganizationSession,
} from './organization-selection.js';
import { presentPriceCheck, withPriceCheck } from './price-check.js';
import { generationContextKey, rememberGeneration } from './recent-generations.js';
import {
  applyEdits,
  DESCRIPTION_EDITS,
  INSTRUCTION_EDITS,
  UNATTENDED_INSTRUCTIONS_PREFIX,
  withoutSpendConfirmation,
} from './spend-confirmation.js';
import {
  createTelemetryQueue,
  isMcpEventsOperation,
  type TelemetryQueue,
  TelemetrySession,
} from './telemetry/index.js';
import { observeRejectedCalls, trackToolCall } from './telemetry/tool-calls.js';
import {
  nameTakenByRenamedTool,
  oldNameAliases,
  previousToolName,
  renamedToolNotice,
  withLegacyAppDescriptors,
} from './tool-names.js';
import { createAccountContextTool } from './tools/account-context.js';
import { createAccountManagementTools } from './tools/account-management.js';
import { createAppTools } from './tools/app-tools.js';
import { createAssetAnalysisTools } from './tools/asset-analysis.js';
import { createAssetCreatorsTool } from './tools/asset-creators.js';
import { createAssetFacesTools } from './tools/asset-faces.js';
import { createAudioTrimTools, supportsAudioTrimming } from './tools/audio-trim.js';
import { BATCH_TOOLS, createBatchTools, isBatchOperation } from './tools/batches.js';
import { billingApprovalOperation, createBillingApprovalTools } from './tools/billing-approval.js';
import {
  createBillingPaymentLinkTools,
  PAYMENT_LINK_TOOL,
  PAYMENT_UNAVAILABLE_IN_CLIENT,
  paysInClient,
} from './tools/billing-payment-links.js';
import {
  createDialogueTools,
  dialogueOperations,
  keyedDialoguePreviews,
} from './tools/dialogue.js';
import { createFacePeopleTool } from './tools/face-people.js';
import { createFeedbackTools, FEEDBACK_INSTRUCTIONS, feedbackOperation } from './tools/feedback.js';
import { adaptGeneratedTool } from './tools/generated-adapters.js';
import { createGenerationContinuationTool } from './tools/generation-continuation.js';
import { createGenerationCostsTools, generationCostsOperation } from './tools/generation-costs.js';
import { withGenerationOutputAliases } from './tools/generation-output.js';
import {
  derivedToolName,
  generateTools,
  operationIdToToolName,
  type ToolRequestContext,
} from './tools/generator.js';
import type { McpToolDefinition } from './tools/index.js';
import { progressSender } from './tools/job-wait.js';
import { createJobsCreateManyTool } from './tools/jobs-create-many.js';
import { createJobsGetManyTool } from './tools/jobs-get-many.js';
import { createJobTools } from './tools/jobs.js';
import { withOrganizationChoice } from './tools/organization-choice.js';
import {
  type CredentialKind,
  createOrganizationTools,
  organizationNextStep,
} from './tools/organizations.js';
import { createPlaybackMetadataTool } from './tools/playback-metadata.js';
import { createProjectHistoryTools } from './tools/project-history.js';
import { withProjectIntent } from './tools/project-intent.js';
import { createShotReviewCardTool } from './tools/shot-review-card.js';
import { createShotReviewTools } from './tools/shot-review.js';
import { createSpeechTools, speechOperations } from './tools/speech.js';
import { createStudioDraftTools, supportsStudioDrafts } from './tools/studio-draft.js';
import { createStudioViewTools, supportsStudioViews } from './tools/studio-view.js';
import {
  createTimelineLipsyncTool,
  timelineClipLimit,
  timelineKeepsClips,
} from './tools/timeline-lipsync.js';
import {
  createTranslationPreviewTools,
  translationPreviewOperations,
} from './tools/translation-preview.js';
import { createTranslationTools, translationOperation } from './tools/translation.js';
import { createUploadWidgetTool, registerUploadWidgetResource } from './tools/upload-widget.js';
import { toolsetIncludes, toolsetInstruction } from './toolsets.js';
import { readUiResource } from './ui-resource-log.js';
import {
  type AvailableUpdate,
  type UpdateCheck,
  updateInstruction,
  updateToolNotice,
} from './update-check.js';
import { PACKAGE_VERSION } from './version.js';

const SERVER_DESCRIPTION =
  'Sync makes photos talk, lipsyncs videos to audio or a script, translates and dubs videos into another language, and edits spoken words while keeping the original speaker voice. ' +
  'Use existing media or upload your own. Check available workflows and estimated generation costs before creating a video.';

// Paragraphs marked appOnly apply only inside the ChatGPT app and its Studio bridge;
// notChatgpt ones cover tools the ChatGPT app does not list. chatgptOnly ones replace a
// notChatgpt part for the ChatGPT app, whose listing may not sell plans or credits.
const INSTRUCTION_PARTS: {
  text: string;
  appOnly?: boolean;
  notChatgpt?: boolean;
  chatgptOnly?: boolean;
}[] = [
  {
    text: 'When helping with Sync, use concise, friendly, lowercase prose. Preserve the exact case of URLs, IDs, code, filenames and quoted user text; follow explicit user style requests. Write lipsync as one word, without a hyphen. ',
  },
  {
    text: 'After successfully answering or completing the request, optionally suggest at most one useful next step tied to the film or project the user has described. Suggest only capabilities supported by tools available in this connection, skip generic or repeated promotions, and do not perform the suggested action unless the user requests it. ',
  },
  { text: ASSET_THUMBNAIL_INSTRUCTIONS },
  {
    text: 'New workflow requests always start a NEW project. Workflow labels such as Translate and Dub are actions, never project references. Never search for or reuse a project by matching its name, or modify the active project merely because it is open. Use an existing project only when the user explicitly requests an update to that project or selects it in the interface; clarify an ambiguous existing-project reference before any write. For social URLs, first create a fresh project with projects_create, a fresh UUID id and the matching defaultWorkflow (translate_and_dub for translation), then use that returned projectId throughout import and generation with projectIntent=explicit. Persist the UUID and reuse it only for retries of this same creation. A project just created for this request is an intentional destination. For new lipsync_create or dubbing_create calls with saved assets, omit projectId and supply a fresh projectCreationKey, preserving it on retries. Other new workflows and preparation tools require projects_create first, with the matching defaultWorkflow, then the returned projectId and projectIntent=explicit. ',
  },
  {
    text: 'Every call runs in one Sync organization, and paid work is created and billed there. account_get-context names it and says how it was chosen. When organizations_list is available and the user names an organization or team, list the organizations and use the matching id; ask if several match. To work in another organization for the rest of the conversation, call organizations_select. To run one paid create in another organization without switching, pass organizationId on that create and on its estimate; reads of the ids it returns stay in that organization. Name the organization when confirming paid work if the user belongs to more than one. A Sync app connection acts only in the organizations ticked when it was connected; when a switch is refused for that, tell the user to reconnect Sync and tick that organization. API keys are bound to one organization and cannot switch. ',
  },
  {
    text: 'When a Sync tool error has nextAction, read it before anything else in the error: its type says what changes the outcome. retry_later: wait retryAfterSeconds, then send the same request once. reduce_input: shorten or shrink the input. upgrade_plan (requiredPlan names the plan), buy_credits, pay_invoice, update_payment_method, confirm_payment and manage_integration need a person: give them the link (nextAction.url) and do not retry until they say it is done. contact_support: stop and tell them to contact sync. support. Never resend a refused request unchanged. ',
    notChatgpt: true,
  },
  {
    text: "When a Sync tool error has nextAction, read it before anything else in the error: its type says what changes the outcome. retry_later: wait retryAfterSeconds, then send the same request once. reduce_input: shorten or shrink the input. upgrade_plan and buy_credits mean the request is not included in the user's current sync. plan or credits: say so plainly, offer what fits instead (such as a shorter input or another model), and if they ask, tell them they can review their plan on their sync. billing page (nextAction.url). Do not recommend a plan, quote prices or encourage upgrading or buying credits. pay_invoice, update_payment_method, confirm_payment and manage_integration need a person: give them the link (nextAction.url) and do not retry until they say it is done. contact_support: stop and tell them to contact sync. support. Never resend a refused request unchanged. ",
    chatgptOnly: true,
  },
  {
    text: "Images ChatGPT generates in this conversation do not reach Sync tools: assets_upload takes only a file the user attached, and Sync does not generate images. When the user wants to use a generated image (for example as the face for lipsync_create), ask them to download it and attach it to the chat, then upload it with assets_upload. Do not pass a sandbox path or a generated image's link instead. ",
    chatgptOnly: true,
  },
  {
    text: 'When billing-approval-links_create is available and nextAction is upgrade_plan or buy_credits, or the user asks to upgrade or buy credits, create an approval link with the requiredPlan or requiredCredits, and the same organizationId if the refused request used one, and give the person its url; it charges nothing, and they approve and pay on sync.so. Afterwards account_get-context shows the new plan and account_get-usage the new balance; check before retrying. ',
    notChatgpt: true,
  },
  {
    text: 'Before lipsync, read fresh account_get-usage in the organization that will run it. Pass the same organizationId as the create call to check another organization without changing the session selection. Free coverage requires plan=null, hasActiveCredits=false, freeGenerationsExhausted=false and enough freeMonthlyLimits.generations remaining for every requested job. For script input, also require freeTtsExhausted=false, enough freeMonthlyLimits.tts remaining, and elevenLabsKeyConnected=false; a connected provider key can incur external speech charges. Check model and duration eligibility with the estimate; missing eligibility is unknown, and its base-rate amount is not a charge for covered work. When the whole request is covered, proceed without mentioning prices or asking for spending confirmation. Paid, external or unknown coverage still requires a quote and spending confirmation; omitted billing fields are unknown. A free lipsync allowance does not prove translation, dialogue previews or voice cloning is free. ',
  },
  {
    text: 'For what a past generation actually cost, use generations_get-costs when available. Find the generation through history if its id is unknown, and ask which one if multiple match. Report dubbing and lipsync separately, credit face value rather than cash paid, and excluded costs. A null total means the full cost is unknown; show knownSubtotalUsd only as a partial amount. Never substitute generations_estimate-cost or start a paid generation to answer a past-cost question. ',
  },
  {
    text: 'In ChatGPT, default new lipsync and image-to-video requests to sync-3, the latest lipsync model, unless the user explicitly chooses another model. Preserve the selected model on an existing draft or an idempotent retry. ',
    appOnly: true,
  },
  {
    text: 'When voices_clone is available, use it only for an explicitly requested reusable voice clone from a sample the user owns or has permission to clone. Confirm the sample and voice name, explain plan/provider restrictions, and do not claim cloning is free. Use the returned id (not the provider voiceId) for lipsync_create with script. After an uncertain clone response, list voices and reconcile before considering another write; never automatically repeat cloning. ',
  },
  {
    text: 'When audio-trims_create is available, offer prefix audio preparation for an over-limit lipsync request, then re-quote the saved asset. Preparation is separate from paid generation. Video partial lipsync uses cut_off and preserves the original media. ',
  },
  {
    text: 'When jobs_create-many is available and the user wants 2 or more independent jobs (one video lipsynced to several audios, dubbed into several languages, or one Edit Dialogue variant per name), start them with one jobs_create-many call instead of calling the create tool repeatedly or using batches_create, and follow them with jobs_get-many. It uses the same API, limits and billing as single calls on every plan. Check free coverage for every item in its own organization. Count only generation jobs against generation allowance, and combine speech-preview and script-input usage against speech allowance per organization. For speech previews, use speech-previews_get-options and ignore generation counters and freeGenerationsExhausted; speech-only sets do not need generation allowance. Fully covered sets need no price mention or spending confirmation; otherwise quote and confirm the whole set once. Never infer free translation or dialogue from a lipsync allowance. Keep batches_create for Scale accounts with large runs (20 to 500) that can wait hours. ',
    notChatgpt: true,
  },
  {
    text: 'Do not offer Sync video workflows for subtitle-only output, text translation, standalone MP3 voiceovers, or timeline editing such as trimming and mixing background music. Explain the supported scope; only offer another capability if a corresponding tool is actually available. ',
  },
  {
    text: 'Edit Dialogue supports targeted edits/removals of existing timed transcript words, with an audio preview in the original speaker voice followed by dialogue-videos_create. It does not support replacing every line with an arbitrary new script. Explain this limit when whole-script replacement is requested; do not promise it or bypass it by splitting the new script into word edits. Do not substitute full-script TTS. Use the dedicated dialogue tools when available; if a required tool is unavailable, explain that the workflow cannot be completed in this connection. ',
  },
  {
    text: 'For a request such as “Translate this YouTube link to Spanish”, first call assets_create with the social URL, type=VIDEO and the selected projectId. YouTube, TikTok, Instagram and Facebook video links are imported into saved assets. A 409 import_in_progress means the import is running: wait retryAfterMs (15 seconds if absent), then repeat the identical assets_create request until it returns an asset. Keep the URL and project unchanged; do not submit a generation while importing or treat importJobId as an asset ID. On import_failed, import_not_enabled, import_unavailable or an import limit error, explain the returned reason and stop; offer a file upload instead of repeatedly starting imports. Once ready, estimate and confirm the paid translation before calling dubbing_create when available with the returned asset id as videoAssetId. ',
  },
  {
    text: 'When dubbing_create is available, use it for translating speech and lipsyncing a saved video. Before confirming the paid action, use generations_estimate-cost with workflow=translate-and-dub if its schema supports that option. Show the combined Sync estimate and disclose excluded external provider charges. Without that option or the returned breakdown, the estimate covers lipsync only; do not present it as the full workflow cost. Confirm the target language and configuration. Reuse its generation id for status polling. ',
  },
  {
    // Nothing reaches the model after its reply ends, so a job it hands back is one no one
    // reports on until the user asks again.
    text: 'After a create returns a generation id, call generations_get with wait: true. While it is still running, keep waiting in this same reply for up to about 15 minutes in total: tell the user once that you are waiting, call generations_get with wait: true again each time it returns unfinished, then give the finished result. Hand back sooner only when generationEstimate expects it to take longer than that or the user asks not to wait; then give the id and say they can ask you to check it. Nothing notifies you after your reply ends, so never say you will watch the job or report back on your own. ',
  },
  {
    text: 'When standalone translation-preview tools are available, the app can translate saved audio before final lipsync. Confirm the source audio, language and quote before translation-previews_create. Persist one UUID key and immutable request; poll the same job, and treat recoveryRequired as unresolved acceptance. Never redub because attaching the output failed. After a translated audio preview is saved, check coverage for a separate lipsync_create-from-assets using that audio; quote and confirm only when it is not fully covered. Do not send it through dubbing_create again. ',
  },
  {
    text: 'When speech-previews_create is available, the app can synthesize a standalone audio preview for its video input. Confirm script, voice and estimated cost. Persist and reuse its idempotencyKey after uncertain admission, poll the same returned job, and never synthesize again because asset attachment failed. ',
  },
  {
    text: 'When Studio publishes a draftId, use studio-drafts_get and studio-drafts_update to change its selections/settings. Chat prose does not select media in Studio. Use the current expectedRevision and confirm UI application only after appliedRevision equals revision. These tools do not start paid work. ',
    appOnly: true,
  },
  {
    text: 'When Studio publishes a viewId, read studio-views_get, then use studio-views_open-project to open a project, studio-views_refresh-project after a rename, studio-views_refresh-assets after uploads, studio-views_show-generation to display an accepted job/result, or studio-views_continue-generation for an explicitly requested continuation. Only an applied receipt confirms UI display. Never repeat backend or paid work to refresh the UI. ',
    appOnly: true,
  },
  {
    text: 'For paid or unknown-coverage script-driven lipsync, call generations_estimate-cost with the actual replacement script when its schema supports script; use measured audioDuration if the replacement audio already exists. Explain the returned durationEstimate and label script-based pricing approximate until synthesis determines the actual length. Never substitute the full source video duration for replacement speech. Disclose speech synthesis separately. If those inputs are unavailable, estimate spoken duration from the script and label it approximate; do not present a source-video quote as the replacement-script price. Re-estimate after script, audio, model or sync-mode changes. ',
  },
  {
    text: 'lipsync_create accepts exactly one visual input (image or video) and one driver (audio or script). For script, call voices_list and select an actual returned voiceId. Public/Sync-hosted media URLs and existing Sync asset IDs in the same organization are supported. For local media, use the Sync interface upload action, or request assets_create-upload-url, PUT the file bytes with its Content-Type, and register the returned URL with assets_create. Use assets_create for public URL imports and projects_create to create a project. The tool defaults to sync-3 and a NEW project. projectName names a new project and never reuses an existing one. Prefer a projectId returned by projects_list when selecting an existing project. When available, use projects_list-generations for history within that project; generations_list is the organization feed. Create once, then poll generations_get by the returned id with wait: true, omitting timeout to use the API default; if still pending, poll that same id rather than creating again. When COMPLETED, return the exact structuredContent.outputMediaUrl verbatim, preserving signed query parameters; outputUrl is a deprecated alias with the same value.',
  },
];

export const SERVER_INSTRUCTIONS = INSTRUCTION_PARTS.filter((part) => !part.chatgptOnly)
  .map((part) => part.text)
  .join('');
const MODEL_ONLY_INSTRUCTIONS = INSTRUCTION_PARTS.filter(
  (part) => !part.appOnly && !part.chatgptOnly,
)
  .map((part) => part.text)
  .join('');
const CHATGPT_INSTRUCTIONS = INSTRUCTION_PARTS.filter((part) => !part.notChatgpt)
  .map((part) => part.text)
  .join('');

export function serverInstructions(
  profile: ClientProfile,
  spendConfirmation = true,
  feedback = false,
  update?: AvailableUpdate,
  toolsetNote = '',
): string {
  const instructions =
    (profile.name === 'chatgpt'
      ? CHATGPT_INSTRUCTIONS
      : profile.supportsAppUi
        ? SERVER_INSTRUCTIONS
        : MODEL_ONLY_INSTRUCTIONS) +
    (feedback ? ` ${FEEDBACK_INSTRUCTIONS.trimEnd()}` : '') +
    (toolsetNote ? ` ${toolsetNote}` : '') +
    (update ? ` ${updateInstruction(update)}` : '');
  return spendConfirmation
    ? instructions
    : UNATTENDED_INSTRUCTIONS_PREFIX + applyEdits(instructions, INSTRUCTION_EDITS);
}

export function serverDescription(spendConfirmation = true): string {
  return spendConfirmation ? SERVER_DESCRIPTION : applyEdits(SERVER_DESCRIPTION, DESCRIPTION_EDITS);
}

const JOB_SET_TOOLS = ['jobs_create-many', 'jobs_get-many'];
const APPROVAL_TOOLS = ['billing-approval-links_create'];
const TOOL_SECURITY_SCHEMES = [{ type: 'oauth2', scopes: [] }] as const;
const APP_UI_TOOLS = new Set([
  'analytics_track-event',
  'sync-app_open',
  'studio-drafts_save',
  'studio-drafts_ack',
  'studio-views_register',
  'studio-views_ack',
]);
export const HOSTED_HTTP_TOOL_ALLOWLIST = new Set([
  ...CARD_TOOL_NAMES,
  'analytics_track-event',
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
  'account_get-usage',
  'generations_get-costs',
  'projects_rename',
  'account_get-context',
  'organizations_list',
  'organizations_select',
  'assets_list-creators',
  'assets_get-playback-metadata',
  'generations_get-continuation',
  'speech-previews_get-options',
  'speech-previews_create',
  'speech-previews_get',
  'dialogue_get-options',
  'dialogue_upload-source',
  'dialogue-transcriptions_create',
  'dialogue-transcriptions_get',
  'dialogue-previews_create',
  'dialogue-previews_get',
  'dialogue-videos_estimate',
  'dialogue-videos_create',
  'sync-app_open',
  'assets_open-upload-widget',
  'assets_upload',
  'lipsync_create',
  'lipsync_create-from-assets',
  'lipsync_create-timeline',
  'feedback_send',
  'dubbing_create',
  'dubbing_get-options',
  'translation-previews_estimate',
  'translation-previews_create',
  'translation-previews_get',
  'audio-trims_create',
  'audio-trims_get',
  'voices_list',
  'voices_clone',
  'generations_get',
  'models_list',
  'projects_list',
  'projects_get',
  'assets_list',
  'assets_count',
  'assets_get',
  'assets_update',
  'assets_delete',
  'assets_get-download-url',
  'assets_create-upload-url',
  'assets_create',
  'projects_create',
  'generations_list',
  'projects_list-generations',
  'generations_estimate-cost',
  // Hidden from the ChatGPT app listing in isToolVisible, as are the jobs_*-many tools.
  'batches_create',
  'batches_get',
  'batches_list',
  'jobs_create-many',
  'jobs_get-many',
  'billing-approval-links_create',
  // Listed only to accounts with the feature; see account-features.ts.
  PAYMENT_LINK_TOOL,
  'scenes_detect',
  'stems_separate',
  'faces_detect',
  'faces_get',
  'faces_get-timeline',
  'faces_get-people',
  'shots_regenerate',
  'shots_splice',
]);
const WIDGET_CALLABLE_HOSTED_TOOLS = new Set([
  'jobs_get-many',
  'shots_regenerate',
  'shots_splice',
  'analytics_track-event',
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
  'account_get-usage',
  'generations_get-costs',
  'projects_rename',
  'account_get-context',
  'assets_list-creators',
  'assets_get-playback-metadata',
  'generations_get-continuation',
  'speech-previews_get-options',
  'speech-previews_create',
  'speech-previews_get',
  'dialogue_get-options',
  'dialogue_upload-source',
  'dialogue-transcriptions_create',
  'dialogue-transcriptions_get',
  'dialogue-previews_create',
  'dialogue-previews_get',
  'dialogue-videos_estimate',
  'dialogue-videos_create',
  'assets_upload',
  'lipsync_create',
  'lipsync_create-from-assets',
  'dubbing_create',
  'dubbing_get-options',
  'translation-previews_estimate',
  'translation-previews_create',
  'translation-previews_get',
  'audio-trims_create',
  'audio-trims_get',
  'voices_list',
  'generations_get',
  'models_list',
  'projects_list',
  'projects_get',
  'assets_list',
  'assets_count',
  'assets_get',
  'assets_update',
  'assets_delete',
  'assets_get-download-url',
  'assets_create-upload-url',
  'assets_create',
  'projects_create',
  'generations_list',
  'projects_list-generations',
  'generations_estimate-cost',
]);

export function createToolDescriptorMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const descriptorMeta: Record<string, unknown> = {
    ...meta,
    securitySchemes: meta?.securitySchemes ?? TOOL_SECURITY_SCHEMES,
  };
  for (const key of ['openai/toolInvocation/invoking', 'openai/toolInvocation/invoked']) {
    const text = descriptorMeta[key];
    if (typeof text === 'string') descriptorMeta[key] = text.toLowerCase();
  }
  return descriptorMeta;
}

// SDK clients validate structured errors too. Retained widgets require this
// envelope; success registration and projection remain independently strict.
const toolErrorOutputSchema = z.toJSONSchema(
  z.object({
    error: z.object({
      message: z.string(),
      status: z.number().int().optional(),
      code: z.string().optional(),
      retryable: z.boolean().optional(),
      retryAfterMs: z.number().finite().optional(),
      generationId: z.string().optional(),
      importJobId: z.uuid().optional(),
      importStatus: z
        .enum(['queued', 'downloading', 'processing', 'completed', 'failed'])
        .optional(),
      progress: z.number().min(0).max(100).optional(),
    }),
  }),
);

// The SDK wraps raw shapes on registration. Reuse immutable validators across
// sessions while keeping handlers, authentication and client profiles local.
const toolInputSchemas = new WeakMap<Record<string, z.ZodType>, z.ZodObject>();

function toolInputSchema(shape: Record<string, z.ZodType>): z.ZodObject {
  let schema = toolInputSchemas.get(shape);
  if (!schema) {
    schema = z.object({
      ...shape,
      syncAnalytics: uiAnalyticsSchema
        .optional()
        .describe('Private UI instrumentation. Omit when calling from conversation.'),
    });
    toolInputSchemas.set(shape, schema);
  }
  return schema;
}

const toolSchemas = new WeakMap<Record<string, z.ZodType>, z.ZodObject>();

function toolSchema(shape: Record<string, z.ZodType>): z.ZodObject {
  let schema = toolSchemas.get(shape);
  if (!schema) {
    schema = z.object(shape);
    toolSchemas.set(shape, schema);
  }
  return schema;
}

// Like the validators above: one descriptor _meta per tool, not one per session.
const NO_META = Object.freeze(createToolDescriptorMeta(undefined));
const registeredMetas = new WeakMap<Record<string, unknown>, Record<string, unknown>>();

function registeredMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return NO_META;
  let descriptorMeta = registeredMetas.get(meta);
  if (!descriptorMeta) {
    descriptorMeta = Object.freeze(createToolDescriptorMeta(meta));
    registeredMetas.set(meta, descriptorMeta);
  }
  return descriptorMeta;
}

export function registerTools(
  server: McpServer,
  tools: McpToolDefinition[],
  authMetadataUrl?: string,
  onToolError?: (tool: string, error: unknown) => void,
  decorateResult: (result: CallToolResult) => CallToolResult = (result) => result,
  isChatgptApp: () => boolean = () => false,
): void {
  const names = new Set(tools.map((tool) => tool.name));
  for (const tool of tools) {
    const config = {
      title: tool.title?.toLowerCase(),
      description: tool.description,
      inputSchema: toolInputSchema(tool.inputSchema),
      outputSchema: tool.outputSchema ? toolSchema(tool.outputSchema) : undefined,
      annotations: tool.annotations,
      _meta: registeredMeta(tool.meta),
    };
    const run = async (
      args: Record<string, unknown> | undefined,
      ctx: Parameters<Parameters<McpServer['registerTool']>[2]>[1],
      calledAs?: string,
    ): Promise<CallToolResult> => {
      // Tools take the request's signal and _meta, not the SDK handler context.
      const context = {
        signal: ctx.mcpReq.signal,
        _meta: ctx.mcpReq._meta,
        ...(calledAs && { calledAs }),
        progress: progressSender(ctx.mcpReq._meta?.progressToken, (notification) =>
          ctx.mcpReq.notify(notification),
        ),
      };
      try {
        if (tool.resultFormat === 'mcp') {
          return decorateResult(
            await tool.handler((args ?? {}) as Record<string, unknown>, context),
          );
        }
        const result = await tool.handler((args ?? {}) as Record<string, unknown>, context);
        return decorateResult(createJsonToolResult(result, tool.outputSchema));
      } catch (error) {
        onToolError?.(tool.name, error);
        return decorateResult(createToolErrorResult(error, authMetadataUrl, isChatgptApp()));
      }
    };
    server.registerTool(tool.name, config, run);
    // The previous name stays callable, unlisted, and says what the tool is called now.
    // An old name that is now another tool's name (generations_estimate-cost) is that tool.
    for (const legacy of oldNameAliases(tool.name).filter((name) => !names.has(name)))
      server.registerTool(legacy, config, async (args, ctx) => {
        const result = await run(args, ctx, legacy);
        return {
          ...result,
          content: [
            ...(result.content ?? []),
            { type: 'text', text: renamedToolNotice(legacy, tool.name) },
          ],
        };
      });
  }
}

/** Each tool under its name and the old names it still answers to. */
function toolsByCallableName(tools: McpToolDefinition[]): Map<string, McpToolDefinition> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const tool of tools)
    for (const legacy of oldNameAliases(tool.name))
      if (!byName.has(legacy)) byName.set(legacy, tool);
  return byName;
}

// Agents resend a rejected request every few seconds unless told what changes the outcome.
const RESUBMIT_FAILS =
  'Sending the same request again fails the same way. Explain the message to the user and change the request before trying again.';
const NEXT_STEP_BY_CODE: Record<string, string> = {
  concurrency_limit_reached:
    'A generation is still running for this account. Poll generations_get with its id, or list running ones with generations_list and status PROCESSING, until it finishes, then submit once. Submitting again before then fails the same way.',
  generation_plan_duration_exceeded:
    'This plan limits how long the output can be. Shorten the script or audio (audio-trims_create keeps the first part of saved audio), quote again, then create once.',
  feature_not_enabled:
    'This Sync account does not have the feature yet. Tell the user it needs to be enabled for their account; calling again fails the same way.',
  generation_not_found:
    'No generation with this id exists in the connected organization. Use the id a create call returned, or find it with projects_list-generations or generations_list; account_get-context names the organization in use. Asking again with the same id fails the same way.',
  stem_separation_source_not_hosted:
    'Stem separation reads only files in Sync storage. Upload the file (assets_create-upload-url, PUT the bytes, then assets_create with the returned URL) and separate the new asset.',
};

// A person pays through an approval link; the agent cannot. Ahead of the code's own step,
// since a payment is what changes the outcome.
const PAYMENT_STEP_BY_ACTION: Record<string, string> = {
  upgrade_plan:
    'This needs a higher plan (nextAction.requiredPlan), or a request that fits the current one. When billing-approval-links_create is available, create a link for that plan and give its url to the person; otherwise give them nextAction.url. The same request fails the same way until account_get-context shows the new plan.',
  buy_credits:
    'This needs more credits (requiredCredits). When billing-approval-links_create is available, create a link for those credits and give its url to the person; otherwise give them nextAction.url. The same request fails the same way until account_get-usage shows the new balance.',
};
// The ChatGPT app's listing may not sell plans or credits or link to checkout (OpenAI app
// guidelines, Commerce and monetization): it may say a request is not in the plan and
// point at an informational page. The billing page shows the plan without starting one.
const CHATGPT_STEP_BY_ACTION: Record<string, string> = {
  upgrade_plan:
    "This is not included in the user's current sync. plan. Say so plainly and offer what fits the current plan instead, such as a shorter input or another model. If they ask, tell them they can review their plan on their sync. billing page (nextAction.url). Do not recommend a plan, quote prices or encourage upgrading. The same request fails the same way until account_get-context shows a different plan.",
  buy_credits:
    'The organization does not have enough sync. credits for this. Say so plainly and offer what fits instead, such as a shorter input. If they ask, tell them they can review billing on their sync. billing page (nextAction.url). Do not quote prices or encourage buying credits. The same request fails the same way until account_get-usage shows a higher balance.',
};

/** The billing page on the same sync. app as a checkout or billing link, or undefined. */
function billingPage(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { origin, protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:'
      ? `${origin}/billing/subscription`
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * For the ChatGPT app: an upgrade or credit refusal points at the billing page, never the
 * approval page, which starts a checkout.
 */
function chatgptBilling(error: ApiRequestError): { details?: ApiErrorDetails; next?: string } {
  const details = error.details;
  const action = details?.nextAction;
  if (!details || !action || !CHATGPT_STEP_BY_ACTION[action.type]) return { details };
  const { url: _checkout, ...rest } = action;
  const page = billingPage(details.billingUrl) ?? billingPage(action.url);
  const { billingUrl: _billing, ...others } = details;
  return {
    details: {
      ...others,
      nextAction: { ...rest, ...(page && { url: page }) },
      ...(page && { billingUrl: page }),
    },
    next: CHATGPT_STEP_BY_ACTION[action.type],
  };
}

const PERSON_ACTS =
  'A person must act at nextAction.url, or billingUrl when it has none: pay an invoice, update the payment method, confirm a payment or fix a connected provider account. Give them the link and wait until they say it is done; the same request fails the same way until then.';
const NEXT_STEP_BY_ACTION: Record<string, string> = {
  pay_invoice: PERSON_ACTS,
  update_payment_method: PERSON_ACTS,
  confirm_payment: PERSON_ACTS,
  manage_integration: PERSON_ACTS,
  retry_later:
    'Wait nextAction.retryAfterSeconds, then send the same request once. Sending it sooner fails the same way.',
  reduce_input:
    'No plan lifts this limit. Shorten or shrink the input, then send it once. ' + RESUBMIT_FAILS,
  contact_support:
    'Only sync. support can resolve this. Tell the user to contact them (nextAction.url); calling again fails the same way.',
};

function nextStep(error: ApiRequestError): string | undefined {
  const organization = organizationNextStep(error);
  if (organization) return organization;
  const action = error.details?.nextAction?.type;
  if (action && PAYMENT_STEP_BY_ACTION[action]) return PAYMENT_STEP_BY_ACTION[action];
  if (error.code && NEXT_STEP_BY_CODE[error.code]) return NEXT_STEP_BY_CODE[error.code];
  if (action && NEXT_STEP_BY_ACTION[action]) return NEXT_STEP_BY_ACTION[action];
  return [400, 402, 403, 422].includes(error.status) ? RESUBMIT_FAILS : undefined;
}

/** One stdout line per failed tool call, for the hosted server's logs. */
export function logToolError(profile: () => string): (tool: string, error: unknown) => void {
  return (tool, error) => {
    const api = error instanceof ApiRequestError ? error : undefined;
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'mcp_tool_error',
        tool,
        profile: profile(),
        status: api?.status,
        code: api?.code,
        source: cameFromApi(error) ? 'api' : 'mcp',
        // Never a message: both ours and the API's quote what the caller sent.
        ...errorFields(error),
      })}\n`,
    );
  };
}

export function createToolErrorResult(
  error: unknown,
  authMetadataUrl?: string,
  chatgptApp = false,
): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ApiRequestError) {
    const billing = chatgptApp ? chatgptBilling(error) : { details: error.details };
    const next = billing.next ?? error.nextStep ?? nextStep(error);
    const structuredContent = {
      error: {
        message,
        status: error.status,
        ...(error.code ? { code: error.code } : {}),
        ...(next ? { nextStep: next } : {}),
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        ...(error.generationId ? { generationId: error.generationId } : {}),
        ...error.importDetails,
        ...billing.details,
      },
    };
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(structuredContent),
        },
      ],
      structuredContent,
      isError: true,
      ...(error.status === 401 && authMetadataUrl
        ? {
            _meta: {
              'mcp/www_authenticate': [
                `Bearer resource_metadata="${authMetadataUrl}", error="invalid_token", error_description="Reconnect your Sync account to continue"`,
              ],
            },
          }
        : {}),
    };
  }
  const retryableError =
    error && typeof error === 'object'
      ? (error as {
          code?: unknown;
          retryable?: unknown;
          retryAfterMs?: unknown;
        })
      : {};
  if (
    typeof retryableError.code === 'string' &&
    retryableError.retryable === true &&
    typeof retryableError.retryAfterMs === 'number'
  ) {
    const structuredContent = {
      error: {
        message,
        code: retryableError.code,
        retryable: true,
        retryAfterMs: retryableError.retryAfterMs,
      },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export function createJsonToolResult(
  result: unknown,
  outputSchema?: Record<string, unknown>,
): CallToolResult {
  const resultForClient =
    outputSchema && isStructuredContent(result)
      ? pickOutputSchemaFields(result, outputSchema)
      : result;
  const callToolResult: CallToolResult = {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(resultForClient, null, 2),
      },
    ],
  };

  if (isStructuredContent(resultForClient)) {
    callToolResult.structuredContent = resultForClient;
  }

  return callToolResult;
}

function pickOutputSchemaFields(
  result: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(outputSchema)) {
    if (key in result) {
      picked[key] = result[key];
    }
  }
  return picked;
}

function isStructuredContent(result: unknown): result is Record<string, unknown> {
  return result !== null && typeof result === 'object' && !Array.isArray(result);
}

// Studio bridge tools need a viewId or draftId that only the ChatGPT widget publishes.
const STUDIO_BRIDGE_TOOLS = new Set([
  'studio-views_get',
  'studio-views_open-project',
  'studio-views_refresh-project',
  'studio-views_refresh-assets',
  'studio-views_show-generation',
  'studio-views_continue-generation',
  'studio-drafts_get',
  'studio-drafts_update',
]);

/** Tools that only work inside the ChatGPT app UI, including widget-only (non-model) tools. */
function isAppOnlyTool(tool: McpToolDefinition): boolean {
  const visibility = asRecord(tool.meta?.ui).visibility;
  return (
    APP_UI_TOOLS.has(tool.name) ||
    STUDIO_BRIDGE_TOOLS.has(tool.name) ||
    (Array.isArray(visibility) && !visibility.includes('model'))
  );
}

function isToolVisible(tool: McpToolDefinition, profile: ClientProfile): boolean {
  if (isAppOnlyTool(tool)) return profile.supportsAppUi;
  // A tool that only shows a card is noise for a client that renders none.
  if (CARD_TOOL_NAMES.has(tool.name) && !profile.supportsStatusCard) return false;
  if (tool.name === 'lipsync_create-from-assets') return profile.supportsAppUi;
  // Kept out of the reviewed ChatGPT app listing; its embedded Studio has no timeline.
  if (tool.name === 'lipsync_create-timeline') return profile.name !== 'chatgpt';
  // Not in the reviewed ChatGPT app listing yet.
  if ([...BATCH_TOOLS, ...JOB_SET_TOOLS, ...APPROVAL_TOOLS].includes(tool.name))
    return profile.name !== 'chatgpt';
  if (tool.name === PAYMENT_LINK_TOOL) return paysInClient(profile);
  // Not in the reviewed ChatGPT app listing yet; other profiles list them per account.
  if (isFeatureGatedTool(tool.name)) return profile.name !== 'chatgpt';
  if (['assets_upload', 'assets_open-upload-widget'].includes(tool.name))
    return profile.supportsUploads;
  return true;
}

export function selectHostedHttpTools(
  tools: McpToolDefinition[],
  profile: ClientProfile = resolveClientProfile(),
): McpToolDefinition[] {
  return tools
    .filter((tool) => HOSTED_HTTP_TOOL_ALLOWLIST.has(tool.name))
    .filter((tool) => isToolVisible(tool, profile))
    .map((tool) => presentTool(tool, profile));
}

function exposeToolToWidget(tool: McpToolDefinition): McpToolDefinition {
  const meta = tool.meta ?? {};
  const ui = asRecord(meta.ui);
  return {
    ...tool,
    meta: {
      ...meta,
      ui: {
        ...ui,
        visibility: ui.visibility ?? ['model', 'app'],
      },
      'openai/widgetAccessible': true,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Profile-specific descriptors and presentation. Authentication remains request-scoped. */
function presentTool(listed: McpToolDefinition, profile: ClientProfile): McpToolDefinition {
  const tool = presentPriceCheck(listed, profile);
  if (profile.supportsUploads)
    return WIDGET_CALLABLE_HOSTED_TOOLS.has(tool.name) ? exposeToolToWidget(tool) : tool;
  const inputSchema = { ...tool.inputSchema };
  let description = tool.description;
  if (tool.name === 'lipsync_create') {
    for (const key of ['video', 'image', 'audio']) delete inputSchema[key];
    description =
      'Create one lipsync video from exactly one visual (videoUrl, videoAssetId, imageUrl or imageAssetId) and one driver (audioUrl, audioAssetId, or script plus voiceId), to make a photo or video say a script or match its lips to supplied audio. When available, use lipsync_create-timeline instead for several audio clips or to lipsync only some ranges of one video, batches_create for 20 or more independent generations, dubbing_create to translate speech, and the Edit Dialogue tools (starting with dialogue_get-options) to change words in existing speech.\n\n' +
      'For a local file, when the assets tools are available, call assets_create-upload-url, PUT the bytes to its uploadUrl with the same Content-Type, register the url it returned (not the uploadUrl) with assets_create, and pass that asset id. provider, stability and similarityBoost apply only to script.\n\n' +
      "This uses the session's organization unless organizationId names another. Check account_get-usage for free coverage; a script also needs free speech allowance and no connected provider key. Fully covered work needs no price mention or spending confirmation; otherwise follow the paid-work instructions. It returns the generation id and status at once; poll generations_get with wait: true until it finishes, then copy outputMediaUrl verbatim.\n\n" +
      "Without projectId it first creates a NEW project, named projectName or a default, even if that name matches existing work. The input combination is checked before that; rejections from the API itself come after the project exists. Pass projectId, with projectIntent=explicit and without projectName or projectCreationKey, only for a project the user explicitly chose or one just created for this request. continuation, from generations_get-continuation, requires the parent generation's projectId.\n\n" +
      'Before calling, persist an idempotencyKey and, without projectId, a fresh projectCreationKey. After a lost or uncertain response, never create again with new keys: if the error names a generationId, poll it with generations_get; otherwise resend the identical request with the same keys.';
    const assetIdDescriptions = {
      videoAssetId:
        'Saved video asset id in the same organization as this call, from assets_list or assets_create when available. Supply exactly one visual input.',
      imageAssetId:
        'Saved still image asset id in the same organization as this call, from assets_list or assets_create when available, for image-to-video lipsync. Supply exactly one visual input.',
      audioAssetId:
        'Saved audio asset id in the same organization as this call, from assets_list or assets_create when available. Supply audio or script, not both.',
    };
    for (const [key, text] of Object.entries(assetIdDescriptions)) {
      inputSchema[key] = z.string().optional().describe(text);
    }
    inputSchema.videoUrl = z
      .string()
      .optional()
      .describe('Public or Sync-hosted video URL. Supply exactly one visual input.');
  }
  const meta = profile.supportsAppUi
    ? tool.meta
    : {
        ...Object.fromEntries(
          Object.entries(tool.meta ?? {}).filter(
            ([key]) => !key.startsWith('openai/') && key !== 'ui',
          ),
        ),
        ...(profile.supportsStatusCard ? cardMeta(tool.name, tool.meta) : {}),
      };
  const presented = { ...tool, inputSchema, description, meta };
  return profile.supportsAppUi && WIDGET_CALLABLE_HOSTED_TOOLS.has(tool.name)
    ? exposeToolToWidget(presented)
    : presented;
}

// Schemas and stateless handlers belong to the factory, not each HTTP session.
// Authentication is resolved per request by createHttpClient; presentation stays local.
function createTools(
  config: SyncMcpConfig,
  operations: ReturnType<typeof parseSpec>,
  httpClient: ReturnType<typeof createHttpClient>,
  getProfile: () => ClientProfile,
  chatgptApp?: ChatgptApp,
): McpToolDefinition[] {
  // stdio authenticates with SYNC_API_KEY when set; otherwise, like hosted, as a user.
  const credential: CredentialKind =
    config.transport === 'stdio' && config.apiKey ? 'api_key' : 'user';
  // These operations require the durable wrapper's admission key and public projection.
  const generatedOperations = operations.filter(
    (operation) =>
      operation.operationId !== 'analytics_captureChatgptEvent' &&
      !isMcpEventsOperation(operation) &&
      !feedbackOperation(operation) &&
      translationPreviewOperations([operation]).length === 0 &&
      !operation.path.startsWith('/v2/audio-trims') &&
      !isBatchOperation(operation) &&
      !billingApprovalOperation(operation) &&
      operation.studioDraftVersion !== 1 &&
      operation.studioViewVersion !== 1 &&
      !generationCostsOperation(operation) &&
      !nameTakenByRenamedTool(derivedToolName(operation.operationId)),
  );
  const exposedOperations =
    config.transport === 'http'
      ? generatedOperations.filter((operation) =>
          HOSTED_HTTP_TOOL_ALLOWLIST.has(operationIdToToolName(operation.operationId)),
        )
      : generatedOperations;
  const generatedTools = generateTools(exposedOperations, httpClient).map((tool, index) =>
    adaptGeneratedTool(tool, exposedOperations[index], httpClient),
  );
  const analyticsAvailable = operations.some(
    (operation) => operation.operationId === 'analytics_captureChatgptEvent',
  );
  const allTools = [
    ...(analyticsAvailable ? [createAnalyticsTool(httpClient)] : []),
    ...(chatgptApp
      ? [
          createOpenSyncAppTool(
            chatgptApp,
            generatedTools.find((tool) => tool.name === 'projects_list'),
          ),
        ]
      : []),
    createUploadWidgetTool(),
    createAccountContextTool(
      httpClient,
      supportsStudioDrafts(operations),
      supportsStudioViews(operations),
      supportsAudioTrimming(operations),
      analyticsAvailable,
      credential,
    ),
    ...createOrganizationTools(httpClient, credential),
    ...createStudioViewTools(operations, httpClient),
    ...createStudioDraftTools(operations, httpClient),
    ...createAccountManagementTools(httpClient),
    ...createBillingApprovalTools(operations, httpClient),
    ...createBillingPaymentLinkTools(httpClient),
    ...createGenerationCostsTools(operations, httpClient),
    createAssetCreatorsTool(httpClient),
    createPlaybackMetadataTool(httpClient),
    createGenerationContinuationTool(httpClient),
    ...createAppTools(httpClient, undefined, getProfile),
    createTimelineLipsyncTool(httpClient, getProfile, {
      maxClips: timelineClipLimit(operations),
      keptClips: timelineKeepsClips(operations),
    }),
    ...createProjectHistoryTools(operations, httpClient),
    ...createTranslationTools(operations, httpClient),
    ...createTranslationPreviewTools(operations, httpClient),
    ...createAudioTrimTools(operations, httpClient),
    ...createBatchTools(operations, httpClient, config.baseUrl),
    ...createDialogueTools(operations, httpClient),
    ...createSpeechTools(operations, httpClient),
    ...createFeedbackTools(operations, httpClient, PACKAGE_VERSION),
    ...createAssetAnalysisTools(httpClient),
    ...createAssetFacesTools(httpClient),
    createFacePeopleTool(httpClient),
    ...createShotReviewTools(httpClient),
    createShotReviewCardTool(httpClient),
    ...generatedTools.map((tool) =>
      config.chatgptApp?.uploadStorageOrigin
        ? relayUploadTool(tool, config.chatgptApp.domain, config.chatgptApp.uploadStorageOrigin)
        : tool,
    ),
  ];
  const spend = (tool: McpToolDefinition) =>
    config.spendConfirmation === false ? withoutSpendConfirmation(tool) : tool;
  const adapted = allTools
    .map(withProjectIntent)
    .map((tool) => withOrganizationChoice(tool, httpClient, credential))
    // Outside the organization choice: a quote's create call is tied to the organization
    // the quote ran in.
    .map(withPriceCheck)
    .map(withGenerationStatusCard)
    .map(withGenerationOutputAliases)
    .map(spend);
  const listed = (tool: McpToolDefinition) =>
    config.transport === 'http'
      ? HOSTED_HTTP_TOOL_ALLOWLIST.has(tool.name)
      : toolsetIncludes(config.toolsets, tool.name, HOSTED_HTTP_TOOL_ALLOWLIST);
  // Readers are built from every tool, so jobs_wait reaches a kind whose own tools a toolset
  // leaves out. jobs_create-many runs creates as client calls, so only listed ones.
  const tools = [
    ...adapted,
    ...createCardTools(adapted),
    ...createJobTools(adapted),
    ...createJobsGetManyTool(adapted),
  ].filter(listed);
  return [
    ...tools,
    ...createJobsCreateManyTool(tools, httpClient, {
      keyedDialoguePreviews: keyedDialoguePreviews(operations),
    }).map(spend),
  ]
    .filter(listed)
    .map(withCard);
}

type CardResource = ReturnType<typeof cardResources>[number];

/** Registers each card through `register` and returns its entry for resources/list. */
function registerCardResources(
  cards: CardResource[],
  register: (card: CardResource, read: () => ReadResourceResult) => unknown,
): Resource[] {
  return cards.map((card) => {
    register(card, () => ({
      contents: [
        {
          uri: card.uri,
          mimeType: card.metadata.mimeType,
          text: card.html,
          _meta: card.metadata._meta,
        },
      ],
    }));
    return { name: card.name, uri: card.uri, ...card.metadata };
  });
}

function createProfiledServer(
  config: SyncMcpConfig,
  operations: ReturnType<typeof parseSpec>,
  authHeaders: AuthSource = {},
  chatgptApp?: ChatgptApp,
  previousApps: ChatgptApp[] = [],
  sharedCatalog?: {
    tools: McpToolDefinition[];
    descriptors: Map<ClientProfile['name'], Tool[]>;
  },
  httpClientName?: string,
  // An initialize request resolves the profile through the handshake, but its
  // response carries the instructions, so they follow the announced client.
  handshakeClientName?: string,
  updateCheck?: UpdateCheck,
  telemetry?: TelemetrySession,
  // The hosted MCP session; scopes per-conversation state when telemetry is off.
  mcpSessionId?: string,
): McpServer {
  let profile: ClientProfile | undefined;
  let clientName: string | undefined = httpClientName;
  const getProfile = () => profile ?? resolveClientProfile();
  const httpClient = createHttpClient(
    config.baseUrl,
    authHeaders,
    config.transport === 'stdio' ? () => clientName : undefined,
  );
  const tools =
    sharedCatalog?.tools ?? createTools(config, operations, httpClient, getProfile, chatgptApp);
  // Hosted sessions supply theirs per request (HttpSession); stdio keeps one for the process.
  const ownOrganizationSession = new OrganizationSession();
  const analytics = toolAnalyticsSupport(operations);
  const server = new McpServer(
    {
      name: 'sync',
      version: PACKAGE_VERSION,
      description: serverDescription(config.spendConfirmation),
    },
    {
      instructions: serverInstructions(
        resolveClientProfile(httpClientName ?? handshakeClientName),
        config.spendConfirmation,
        operations.some(feedbackOperation),
        // The hosted server deploys on every merge, so only local installs report updates.
        config.transport === 'stdio' ? updateCheck?.available() : undefined,
        config.transport === 'stdio' ? toolsetInstruction(config.toolsets) : '',
      ),
    },
  );
  // Keep the SDK's input/output validation and execution. Hidden upload tools remain
  // callable only to return an actionable error; they cannot perform any upload.
  const handlers = new Map<string, McpToolDefinition['handler']>();
  // jobs_create-many runs each item through the same checks as a client's own call.
  const callTool: NonNullable<ToolRequestContext['callTool']> = async (name, args, nested) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`${name} is not available on this connection.`);
    return handler(args, nested);
  };
  const sessionTools = tools.map(
    (tool) =>
      ({
        ...tool,
        handler: async (...parameters: Parameters<typeof tool.handler>) =>
          telemetry
            ? trackToolCall(telemetry, tool, parameters[0], parameters[1], () =>
                runSessionTool(tool, parameters),
              )
            : runSessionTool(tool, parameters),
      }) as McpToolDefinition,
  );
  // One client or nested call: the session's checks, then the tool in its organization.
  async function runSessionTool(
    tool: McpToolDefinition,
    parameters: Parameters<McpToolDefinition['handler']>,
  ): Promise<unknown> {
    const [args] = parameters;
    if (!profile) throw new Error('Complete MCP initialization before calling tools.');
    if (isAppOnlyTool(tool) && !profile.supportsAppUi)
      throw new Error('Open the Sync app in ChatGPT, or use the Sync tools in this client.');
    if (tool.name === PAYMENT_LINK_TOOL && !paysInClient(profile))
      throw new Error(PAYMENT_UNAVAILABLE_IN_CLIENT);
    if (
      !profile.supportsUploads &&
      (['assets_upload', 'assets_open-upload-widget'].includes(tool.name) ||
        (tool.name === 'lipsync_create' &&
          ['video', 'image', 'audio'].some((key) => args[key] !== undefined)))
    ) {
      throw new Error(UNSUPPORTED_UPLOAD_MESSAGE);
    }
    const activeProfile = profile;
    const organizationSession = currentOrganizationSession() ?? ownOrganizationSession;
    // A nested call (jobs_create-many's items) keeps the key of the call that made it.
    const generationKey =
      parameters[1]?.generationKey ??
      generationContextKey(parameters[1]?._meta, mcpSessionId ?? telemetry?.id, config.transport);
    const execute = () =>
      trackToolExecution(
        // The analytics collector still names tools as they were before the rename.
        previousToolName(tool.name) ?? tool.name,
        args,
        parameters[1]?._meta,
        activeProfile.name,
        httpClient,
        async (businessArgs) => {
          const result = await tool.handler(businessArgs, {
            ...parameters[1],
            clientProfile: activeProfile,
            clientName,
            callTool,
            ...(telemetry && { telemetrySessionId: telemetry.id }),
            ...(generationKey && { generationKey }),
            // Only stdio holds a connection that can carry an unrelated notification.
            ...(config.transport === 'stdio'
              ? {
                  toolListChanged: () => void server.server.sendToolListChanged().catch(() => {}),
                }
              : {}),
          });
          rememberGeneration(generationKey, tool.name, result);
          return result;
        },
        analytics,
      );
    // Each call keeps the organization it started in, even if the session switches.
    const organization = organizationForCall(tool, args, organizationSession);
    return runInOrganizationSession(organizationSession, () =>
      runInOrganization(organization, execute),
    );
  }
  for (const tool of sessionTools) handlers.set(tool.name, tool.handler);
  registerTools(
    server,
    sessionTools,
    config.transport === 'http' ? resourceMetadataUrl(config.port) : undefined,
    // stdout is the protocol channel over stdio.
    config.transport === 'http' ? logToolError(() => getProfile().name) : undefined,
    config.transport === 'stdio' && updateCheck ? withUpdateNotice(updateCheck) : undefined,
    () => getProfile().name === 'chatgpt',
  );
  observeRejectedCalls(server, telemetry, () => toolsByCallableName(sessionTools));
  const resources: Resource[] = [];
  const statusMetadata = generationStatusMetadata(config.chatgptApp);
  resources.push({
    name: 'sync-generation-status',
    uri: GENERATION_STATUS_URI,
    ...statusMetadata,
  });
  const appOnly = 'This interface requires an app-compatible client.';
  const uiRead = (resource: string, refused: false | string, message = appOnly) => ({
    resource,
    profile: getProfile(),
    clientName,
    refusal: refused === false ? undefined : { reason: refused, message },
  });
  const statusCardRead = (resource: string) =>
    uiRead(resource, !getProfile().supportsStatusCard && 'no_status_card');
  server.registerResource('sync-generation-status', GENERATION_STATUS_URI, statusMetadata, () =>
    readUiResource(statusCardRead(GENERATION_STATUS_URI), () => ({
      contents: [
        {
          uri: GENERATION_STATUS_URI,
          mimeType: statusMetadata.mimeType,
          text: GENERATION_STATUS_HTML,
          _meta: statusMetadata._meta,
        },
      ],
    })),
  );
  // The other cards are the same packaged bundle, each under its own resource.
  resources.push(
    ...registerCardResources(cardResources(config.chatgptApp), (card, read) =>
      server.registerResource(card.name, card.uri, card.metadata, () =>
        readUiResource(statusCardRead(card.uri), read),
      ),
    ),
  );
  registerUploadWidgetResource({
    registerResource: (name, uri, metadata, read) => {
      resources.push({ name, uri, ...metadata });
      return server.registerResource(name, uri, metadata, (url, ctx) =>
        readUiResource(
          uiRead(
            url.toString(),
            !getProfile().supportsUploads && 'no_uploads',
            UNSUPPORTED_UPLOAD_MESSAGE,
          ),
          () => read(url, ctx),
        ),
      );
    },
  });
  for (const [index, app] of (chatgptApp ? [chatgptApp, ...previousApps] : []).entries()) {
    if (index === 0) resources.push({ name: 'sync-app', uri: app.uri, ...app.metadata });
    server.registerResource(
      index === 0 ? 'sync-app' : `sync-app-previous-${index}`,
      app.uri,
      app.metadata,
      () =>
        readUiResource(uiRead(app.uri, !getProfile().supportsAppUi && 'no_app_ui'), () => ({
          contents: [
            {
              uri: app.uri,
              mimeType: app.metadata.mimeType,
              text: app.html,
              _meta: app.metadata._meta,
            },
          ],
        })),
    );
  }
  let descriptors: Tool[] = [];
  server.server.setRequestHandler('tools/list', async () => {
    if (!profile) throw new Error('Complete MCP initialization before listing tools.');
    // Feature-gated tools follow the session's active organization (organizations_select).
    const session = currentOrganizationSession() ?? ownOrganizationSession;
    return { tools: await listedForAccount(descriptors, session, httpClient) };
  });
  server.server.setRequestHandler('resources/list', () => ({
    resources: resources.filter((resource) => {
      if (resource.name === 'sync-app') return getProfile().supportsAppUi;
      if (CARD_RESOURCE_NAMES.has(resource.name)) return getProfile().supportsStatusCard;
      return getProfile().supportsUploads;
    }),
  }));
  const onInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    if (!profile) {
      clientName ??= server.server.getClientVersion()?.name;
      const initializedProfile = resolveClientProfile(clientName);
      profile = initializedProfile;
      const cached = sharedCatalog?.descriptors.get(initializedProfile.name);
      if (cached) {
        descriptors = cached;
        onInitialized?.();
        return;
      }
      const visible =
        config.transport === 'http'
          ? selectHostedHttpTools(tools, initializedProfile)
          : tools
              .filter((tool) => isToolVisible(tool, initializedProfile))
              .map((tool) => presentTool(tool, initializedProfile));
      descriptors = visible.map((tool) => ({
        name: tool.name,
        title: tool.title?.toLowerCase(),
        description: tool.description,
        // Only the ChatGPT app UI sends syncAnalytics; other clients never see the field.
        inputSchema: z.toJSONSchema(
          initializedProfile.supportsAppUi
            ? toolInputSchema(tool.inputSchema)
            : toolSchema(tool.inputSchema),
        ) as Tool['inputSchema'],
        ...(tool.outputSchema
          ? {
              outputSchema: {
                type: 'object',
                anyOf: [z.toJSONSchema(z.object(tool.outputSchema)), toolErrorOutputSchema],
              } as Tool['outputSchema'],
            }
          : {}),
        annotations: tool.annotations,
        _meta: createToolDescriptorMeta(tool.meta),
        securitySchemes: tool.meta?.securitySchemes ?? TOOL_SECURITY_SCHEMES,
      }));
      // Like gated tools, gated inputs stay out of the reviewed ChatGPT app listing.
      if (initializedProfile.name === 'chatgpt')
        descriptors = descriptors.map((tool) => withoutGatedParameters(tool));
      if (initializedProfile.supportsAppUi) descriptors = withLegacyAppDescriptors(descriptors);
      else if (initializedProfile.supportsStatusCard) descriptors = withStatusCardTool(descriptors);
      sharedCatalog?.descriptors.set(initializedProfile.name, descriptors);
    }
    onInitialized?.();
  };
  if (httpClientName !== undefined) server.server.oninitialized();
  return server;
}

function rememberedElsewhere(remembered: RanIn, session: OrganizationSession): Error {
  const id = remembered?.id ?? session.defaultId();
  const where = remembered
    ? `organization ${remembered.name ?? remembered.id}`
    : 'the default organization of this connection';
  return new Error(
    `This request uses an id created in ${where}, but this session now runs in ${session.selected?.name ?? 'another organization'}. ${id ? `Pass organizationId "${id}" to work in that organization` : 'Switch back with organizations_select'}, or use media and projects from the current one.`,
  );
}

// Reads that follow ids a one-call organizationId created; jobs_* only read jobs too.
function followsRememberedIds(tool: McpToolDefinition): boolean {
  return tool.annotations?.readOnlyHint === true || ['jobs_get', 'jobs_wait'].includes(tool.name);
}

/**
 * The organization a call runs in: the session's selection, or, for a read of an id that a
 * one-call organizationId created, that organization. A write naming such an id in another
 * organization than the session's is refused unless it names the organization itself.
 */
function organizationForCall(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
  session: OrganizationSession,
): OrganizationSummary | undefined {
  const remembered = session.organizationFor(args);
  if (remembered === undefined || session.isCurrent(remembered)) return session.selected;
  // null: the credential's own organization, which a call reaches by sending no header.
  if (followsRememberedIds(tool)) return remembered ?? undefined;
  if (args.organizationId === undefined) throw rememberedElsewhere(remembered, session);
  return session.selected;
}

/**
 * Adds the update notice to the first tool result after the check finds a newer version,
 * once per session, including when it finished after the instructions were sent. It is a
 * trailing text block, so structuredContent and the leading JSON text stay unchanged.
 */
function withUpdateNotice(updateCheck: UpdateCheck): (result: CallToolResult) => CallToolResult {
  let delivered = false;
  return (result) => {
    const update = delivered ? undefined : updateCheck.available();
    if (!update) return result;
    delivered = true;
    return {
      ...result,
      content: [...(result.content ?? []), { type: 'text', text: updateToolNotice(update) }],
    };
  };
}

/** Whether the API's schema lists the MCP events collector now, for a server that started first. */
function collectorCheck(baseUrl: string) {
  return async () => parseSpec(await fetchSpec(baseUrl)).find(isMcpEventsOperation);
}

export async function createSyncMcpServer(
  config: SyncMcpConfig,
  options: { updateCheck?: UpdateCheck } = {},
): Promise<McpServer> {
  const log = (message: string) => {
    process.stderr.write(message);
  };
  const authHeaders = config.transport === 'http' ? {} : await resolveAuth(config, log);
  const operations = parseSpec(await fetchSpec(config.baseUrl));
  const [chatgptApp, ...previousApps] = await loadChatgptAppReleases(config.chatgptApp);
  const queue = createTelemetryQueue(
    config.telemetry !== false,
    operations,
    createHttpClient(config.baseUrl, authHeaders),
    collectorCheck(config.baseUrl),
  );
  const telemetry = queue && new TelemetrySession(queue, 'stdio', config.referralSource);
  const server = createProfiledServer(
    config,
    operations,
    authHeaders,
    chatgptApp,
    previousApps,
    undefined,
    undefined,
    undefined,
    options.updateCheck,
    telemetry,
  );
  if (queue && telemetry) recordStdioSession(server, config, queue, telemetry);
  return server;
}

/** stdio has one session per process: it starts at initialization and ends at close. */
function recordStdioSession(
  server: McpServer,
  config: SyncMcpConfig,
  queue: TelemetryQueue,
  telemetry: TelemetrySession,
): void {
  const onInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    onInitialized?.();
    const client = server.server.getClientVersion();
    telemetry.setClient(client?.name, client?.version);
    telemetry.initialized({
      protocolVersion: server.server.getNegotiatedProtocolVersion(),
      capabilities: server.server.getClientCapabilities(),
      toolsets: config.toolsets,
      spendConfirmation: config.spendConfirmation,
    });
  };
  const onClose = server.server.onclose;
  server.server.onclose = () => {
    onClose?.();
    queue.flush();
  };
}

export async function createMcpServerFactory(config: SyncMcpConfig): Promise<{
  createServer: (
    clientName?: string,
    handshakeClientName?: string,
    telemetry?: TelemetrySession,
    mcpSessionId?: string,
  ) => McpServer;
  toolCount: number;
  /** Undefined when telemetry is off; inactive until the API collects MCP events. */
  telemetry?: TelemetryQueue;
}> {
  const [chatgptApp, ...previousApps] = await loadChatgptAppReleases(config.chatgptApp);
  // Filter and build schemas once. Session profiles and SDK transports stay local.
  const operations = parseSpec(await fetchSpec(config.baseUrl)).filter(
    (operation) =>
      operation.operationId === 'analytics_captureChatgptEvent' ||
      isMcpEventsOperation(operation) ||
      feedbackOperation(operation) ||
      // Read for its published segment limit; raw generation stays unhosted.
      (operation.method === 'post' && operation.path === '/v2/generate') ||
      HOSTED_HTTP_TOOL_ALLOWLIST.has(operationIdToToolName(operation.operationId)) ||
      generationCostsOperation(operation) ||
      translationOperation([operation]) !== undefined ||
      translationPreviewOperations([operation]).length > 0 ||
      operation.path === '/v2/audio-trims' ||
      operation.path === '/v2/audio-trims/{id}' ||
      isBatchOperation(operation) ||
      dialogueOperations([operation]).length > 0 ||
      speechOperations([operation]).length > 0 ||
      operation.studioDraftVersion === 1 ||
      operation.studioViewVersion === 1,
  );
  const tools = createTools(
    config,
    operations,
    createHttpClient(config.baseUrl),
    resolveClientProfile,
    chatgptApp,
  );

  // Four presentation profiles at most; never key this by untrusted client names.
  const sharedCatalog = {
    tools,
    descriptors: new Map<ClientProfile['name'], Tool[]>(),
  };
  return {
    // Number registered across hosted profiles, not each client's visible catalog.
    toolCount: new Set(tools.map((tool) => tool.name)).size,
    telemetry: createTelemetryQueue(
      config.telemetry !== false,
      operations,
      createHttpClient(config.baseUrl),
      collectorCheck(config.baseUrl),
    ),
    createServer: (clientName, handshakeClientName, telemetry, mcpSessionId) =>
      createProfiledServer(
        config,
        operations,
        {},
        chatgptApp,
        previousApps,
        sharedCatalog,
        clientName,
        handshakeClientName,
        undefined,
        telemetry,
        mcpSessionId,
      ),
  };
}

async function resolveAuth(
  config: SyncMcpConfig,
  log: (message: string) => void,
): Promise<AuthSource> {
  if (config.apiKey) {
    log('Using API key authentication\n');
    return createApiKeyAuth(config.apiKey).headers;
  }

  // An emailed-code sign-in stays signed in: a refusal mid-session says to sign in
  // again, where a device flow nobody is watching would only hang.
  const emailLogin = await savedEmailLogin(config.baseUrl);
  if (emailLogin) {
    log('Using the saved sync. sign-in\n');
    return emailLoginAuth(emailLogin);
  }

  const cachedToken = await loadToken();
  if (cachedToken) {
    log('Using cached device auth token\n');
    return {
      Authorization: `Bearer ${cachedToken}`,
    };
  }

  log('No API key or cached token found. Starting device auth...\n');
  const auth = await performDeviceAuth(config.baseUrl, log);
  return auth.headers;
}
