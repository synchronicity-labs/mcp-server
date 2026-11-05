import type { Tool } from '@modelcontextprotocol/server';
import type { HttpClient } from './http-client.js';
import { type OrganizationSession, runInOrganizationSession } from './organization-selection.js';
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
};

export function isFeatureGatedTool(name: string): boolean {
  return Object.hasOwn(TOOL_FEATURES, name);
}

// tools/list waits on this read, so it must not take the API's full request budget.
const FEATURES_TIMEOUT_MS = 5_000;

/**
 * The active organization's features, kept on the MCP session's OrganizationSession: the
 * stdio process, or one hosted session. organizations_select and get-account-context write
 * the same field when they read the account, so an organization switch changes what is
 * listed. An API without the field means none. A failed read lists no gated tools and keeps
 * nothing, so a later list reads again.
 */
async function sessionFeatures(
  session: OrganizationSession,
  http: HttpClient,
): Promise<ReadonlySet<string>> {
  if (session.features) return new Set(session.features);
  const selected = session.selected?.id;
  try {
    // In the session, so the read names its selected organization like any other call.
    const overview = await runInOrganizationSession(session, () =>
      http.request('get', '/v2/account', { signal: AbortSignal.timeout(FEATURES_TIMEOUT_MS) }),
    );
    const features = parseAccountOverview(overview).features ?? [];
    // A switch while this read ran wrote the new organization's features; keep those.
    if (session.selected?.id === selected && !session.features) session.features = features;
    return new Set(features);
  } catch {
    return new Set();
  }
}

/** The descriptors this organization may see; reads features only when a gated tool is listed. */
export async function listedForAccount(
  descriptors: Tool[],
  session: OrganizationSession,
  http: HttpClient,
): Promise<Tool[]> {
  if (!descriptors.some((tool) => isFeatureGatedTool(tool.name))) return descriptors;
  const enabled = await sessionFeatures(session, http);
  return descriptors.filter(
    (tool) => !isFeatureGatedTool(tool.name) || enabled.has(TOOL_FEATURES[tool.name]!),
  );
}
