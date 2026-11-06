import type { McpToolDefinition } from './tools/generator.js';

/**
 * Unattended mode: an operator who runs the server for automation (a scheduled agent,
 * a pipeline) has already approved spending, so prose telling the agent to quote costs
 * and wait for a human's confirmation only stalls the run. The operator turns it off with
 * SYNC_MCP_SPEND_CONFIRMATION=off or --no-spend-confirmation; agents cannot.
 *
 * Each edit replaces one exact sentence. spend-confirmation.test.ts fails when a sentence
 * below no longer appears in its source, so wording changes cannot silently undo this.
 */
type Edit = readonly [from: string, to: string];

export const UNATTENDED_INSTRUCTIONS_PREFIX =
  'This connection runs unattended automation, and its operator has already approved spending. Do not quote prices, estimate costs or ask anyone to confirm a paid action unless the request is about cost; create once, then poll the returned job. ';

export const DESCRIPTION_EDITS: readonly Edit[] = [
  [
    'Check available workflows and estimated generation costs before creating a video.',
    'Check available workflows before creating a video.',
  ],
];

export const INSTRUCTION_EDITS: readonly Edit[] = [
  [
    'Once ready, estimate and confirm the paid translation before calling dubbing_create when available with the returned asset id as videoAssetId. ',
    'Once ready, call dubbing_create when available with the returned asset id as videoAssetId. ',
  ],
  [
    'Before confirming the paid action, use generations_estimate-cost with workflow=translate-and-dub if its schema supports that option. Show the combined Sync estimate and disclose excluded external provider charges. Without that option or the returned breakdown, the estimate covers lip-sync only; do not present it as the full workflow cost. Confirm the target language and configuration. ',
    '',
  ],
  ['Confirm the source audio, language and quote before translation-previews_create. ', ''],
  [
    'After a translated audio preview is saved, estimate and confirm a separate lipsync_create-from-assets using that audio;',
    'After a translated audio preview is saved, lipsync with that audio in a separate lipsync_create-from-assets or lipsync_create-timeline;',
  ],
  ['Confirm script, voice and estimated cost. ', ''],
  [
    'then re-quote the saved asset. Preparation is separate from paid generation. ',
    'then use the saved asset. ',
  ],
  [
    'Before quoting script-driven lipsync, call generations_estimate-cost with the actual replacement script when its schema supports script; use measured audioDuration if the replacement audio already exists. Explain the returned durationEstimate and label script-based pricing approximate until synthesis determines the actual length. Never substitute the full source video duration for replacement speech. Disclose speech synthesis separately. If those inputs are unavailable, estimate spoken duration from the script and label it approximate; do not present a source-video quote as the replacement-script price. Re-estimate after script, audio, model or sync-mode changes. ',
    '',
  ],
];

export const TOOL_DESCRIPTION_EDITS: Readonly<Record<string, readonly Edit[]>> = {
  assets_create: [
    [' Import first, then estimate and confirm translation.', ' Import first, then translate.'],
  ],
  lipsync_create: [
    [
      'Before confirming, estimate using the replacement script or measured audio duration, not the source video length. Script-based quotes are approximate and exclude speech synthesis. ',
      '',
    ],
  ],
  'lipsync_create-timeline': [['Estimate and confirm before creating; this starts', 'This starts']],
  batches_create: [
    [
      'This is a paid action: every item is billed as its own generation. Before creating, estimate a representative item with generations_estimate-cost, tell the user the item count and the estimated total, and wait for their confirmation. ',
      'Every item is billed as its own generation. ',
    ],
  ],
  dubbing_create: [
    [' before estimating or calling this tool', ' before calling this tool'],
    [
      'This is a paid action: confirm the requested language, configuration and estimated cost with the user before calling. Use generations_estimate-cost with workflow=translate-and-dub when that input is supported, and disclose any excluded external provider charges. Without the combined breakdown, lip-sync pricing is not the full workflow cost. ',
      '',
    ],
  ],
  'translation-previews_create': [
    ['Start one paid job that translates', 'Start one job that translates'],
    [
      'Confirm the source audio, target language and the translation-previews_estimate quote with the user first. ',
      '',
    ],
    ['is a separate, explicitly approved lipsync_create', 'is a separate lipsync_create'],
  ],
  // Permission to reuse a voice is consent, not spend, so it stays.
  'dialogue-previews_create': [
    [
      'May clone the source speaker voice and incur synthesis charges; confirm the edits and permission to use that voice before creating.',
      'May clone the source speaker voice; confirm permission to use that voice before creating.',
    ],
  ],
  'dialogue-videos_create': [
    [
      "This is a paid action that starts a generation job and consumes sync. credits. First use dialogue-videos_estimate with the same source, preview and model, then obtain the user's approval of the preview, configuration and estimated cost. ",
      'This starts a generation job. ',
    ],
  ],
  'speech-previews_create': [[' This is a potentially paid action.', '']],
  'audio-trims_create': [
    ['Explain and confirm the partial duration first. ', ''],
    [
      'use its assetId and actual duration for a fresh quote.',
      'use its assetId and actual duration.',
    ],
  ],
};

export function applyEdits(text: string, edits: readonly Edit[]): string {
  return edits.reduce((result, [from, to]) => result.replace(from, to), text);
}

export function withoutSpendConfirmation(tool: McpToolDefinition): McpToolDefinition {
  const edits = TOOL_DESCRIPTION_EDITS[tool.name];
  return edits ? { ...tool, description: applyEdits(tool.description, edits) } : tool;
}

/** SYNC_MCP_SPEND_CONFIRMATION accepts off/false/0 (unattended) and on/true/1 (default). */
export function parseSpendConfirmation(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['off', 'false', '0', 'no'].includes(normalized)) return false;
  if (['on', 'true', '1', 'yes'].includes(normalized)) return true;
  throw new Error(`SYNC_MCP_SPEND_CONFIRMATION must be on or off, not "${value}"`);
}
