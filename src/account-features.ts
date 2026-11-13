import type { Tool } from '@modelcontextprotocol/server';
import type { HttpClient } from './http-client.js';
import { type OrganizationSession, runInOrganizationSession } from './organization-selection.js';
import { currentToolName } from './tool-names.js';
import { parseAccountOverview } from './tools/organizations.js';

/**
 * Tools listed only when the active organization's GET /v2/account `features` names the
 * feature: their API routes are behind server-side flags, so other accounts would only get a
 * 404. A tool call is not refused here; the API stays the authority, and the tool reports
 * its 404.
 */
const TOOL_FEATURES: Readonly<Record<string, string>> = {
  scenes_detect: 'scene_detection',
  stems_separate: 'stem_separation',
  faces_detect: 'face_validation',
  faces_get: 'face_validation',
  'faces_get-timeline': 'lipsync_planning',
  'faces_get-people': 'lipsync_planning',
  shots_regenerate: 'lipsync_planning',
  shots_splice: 'lipsync_planning',
};

/**
 * Optional inputs of listed tools that only accounts with the feature see, for request
 * fields the API refuses without it. Like a gated tool, a call with one is not refused here.
 */
const PARAMETER_FEATURES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  lipsync_create: { shots: 'lipsync_planning' },
  'lipsync_create-timeline': { shots: 'lipsync_planning' },
};

export function isFeatureGatedTool(name: string): boolean {
  return Object.hasOwn(TOOL_FEATURES, name);
}

function gatedParameters(tool: Tool): [name: string, feature: string][] {
  const properties = tool.inputSchema.properties ?? {};
  // App profiles also list a renamed tool under its old name (withLegacyAppDescriptors).
  return Object.entries(PARAMETER_FEATURES[currentToolName(tool.name)] ?? {}).filter(([name]) =>
    Object.hasOwn(properties, name),
  );
}

/** The descriptor without the gated inputs whose feature is not in `enabled`. */
export function withoutGatedParameters(tool: Tool, enabled: ReadonlySet<string> = new Set()): Tool {
  const hidden = gatedParameters(tool).filter(([, feature]) => !enabled.has(feature));
  if (hidden.length === 0) return tool;
  const properties = { ...tool.inputSchema.properties };
  for (const [name] of hidden) delete properties[name];
  return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
}

const isGated = (tool: Tool) => isFeatureGatedTool(tool.name) || gatedParameters(tool).length > 0;

// tools/list waits on this read, so it must not take the API's full request budget.
const FEATURES_TIMEOUT_MS = 5_000;

/**
 * The active organization's features, kept on the MCP session's OrganizationSession: the
 * stdio process, or one hosted session. organizations_select and account_get-context write
 * the same field when they read the account, so an organization switch changes what is
 * listed. An API without the field means none. A failed read lists no gated tools and keeps
 * nothing, so a later list reads again.
 */
async function sessionFeatures(
  session: OrganizationSession,
  http: HttpClient,
): Promise<ReadonlySet<string>> {
  const kept = session.activeFeatures();
  if (kept) return new Set(kept);
  const stamp = session.featureStamp();
  try {
    // In the session, so the read names its selected organization like any other call.
    const overview = parseAccountOverview(
      await runInOrganizationSession(session, () =>
        http.request('get', '/v2/account', { signal: AbortSignal.timeout(FEATURES_TIMEOUT_MS) }),
      ),
    );
    const features = overview.features ?? [];
    // Not kept if the session switched meanwhile or the answer is for another organization.
    session.recordFeatures(features, stamp, overview.organization?.id);
    return new Set(features);
  } catch {
    return new Set();
  }
}

/**
 * The descriptors this organization may see; reads features only when a gated tool or
 * input is listed.
 */
export async function listedForAccount(
  descriptors: Tool[],
  session: OrganizationSession,
  http: HttpClient,
): Promise<Tool[]> {
  if (!descriptors.some(isGated)) return descriptors;
  const enabled = await sessionFeatures(session, http);
  return descriptors
    .filter((tool) => !isFeatureGatedTool(tool.name) || enabled.has(TOOL_FEATURES[tool.name]!))
    .map((tool) => withoutGatedParameters(tool, enabled));
}
