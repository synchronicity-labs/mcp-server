import { createHash } from 'node:crypto';
import { getAuthOwner } from './auth/async-context.js';
import { resultFacets } from './telemetry/facets.js';

/**
 * The generation each conversation last created or read, so a feedback report that
 * leaves generationId out can still point the team at the output it is about. Agents
 * often describe a result without naming it, and the report is useless without it.
 * Process-local, like hosted sessions; nothing here is sent anywhere by itself.
 */
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only tools that create or read a generation. Other results can carry ids the telemetry
// facets read as a generation, such as a translation preview job.
const GENERATION_TOOLS = new Set([
  'lipsync_create',
  'lipsync_create-from-assets',
  'lipsync_create-timeline',
  'dubbing_create',
  'dialogue-videos_create',
  'generations_create',
  'generations_get',
  'generations_get-continuation',
]);

const entries = new Map<string, { id: string; at: number }>();

/**
 * Who and which conversation a call belongs to: the verified owner (or this stdio
 * process), then ChatGPT and Codex's conversation, else the MCP session. Undefined when
 * neither is known, so unrelated calls never share a key.
 */
export function generationContextKey(
  meta: Record<string, unknown> | undefined,
  sessionId: string | undefined,
  transport: 'http' | 'stdio',
): string | undefined {
  const owner = transport === 'stdio' ? 'stdio' : getAuthOwner();
  if (!owner) return undefined;
  const session = meta?.['openai/session'];
  const conversation =
    typeof session === 'string' && session.length <= 1024
      ? createHash('sha256').update(session).digest('hex')
      : undefined;
  const scope = conversation ?? sessionId ?? (transport === 'stdio' ? 'process' : undefined);
  return scope ? JSON.stringify([owner, scope]) : undefined;
}

/** The generation a tool result created or describes, if any. */
function generationIn(tool: string, result: unknown): string | undefined {
  if (!GENERATION_TOOLS.has(tool)) return undefined;
  const facets = resultFacets(tool, result);
  if (typeof facets.generation_id === 'string') return facets.generation_id;
  // generations_get answers with the generation itself.
  if (tool !== 'generations_get' || !result || typeof result !== 'object') return undefined;
  const body = result as { id?: unknown; structuredContent?: { id?: unknown } };
  const id = body.structuredContent?.id ?? body.id;
  return typeof id === 'string' && UUID.test(id) ? id : undefined;
}

export function rememberGeneration(
  key: string | undefined,
  tool: string,
  result: unknown,
  now = Date.now(),
): void {
  if (!key) return;
  const id = generationIn(tool, result);
  if (!id) return;
  entries.delete(key);
  entries.set(key, { id, at: now });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function recentGeneration(key: string | undefined, now = Date.now()): string | undefined {
  if (!key) return undefined;
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (now - entry.at < TTL_MS) return entry.id;
  entries.delete(key);
  return undefined;
}
