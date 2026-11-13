import { createHmac, randomBytes } from 'node:crypto';
import { resolveClientProfile } from './client-profile.js';

const CLIENTS = new Set([
  'chatgpt',
  'openai',
  'openai-chatgpt',
  'openai-mcp',
  'openai-mcp (codex)',
  'claude',
  'claude-ai',
  'claude-code',
  'anthropic/claudeai',
  // Codex with Sync in its own mcp_servers config, not through the ChatGPT connector.
  'codex-mcp-client',
  'cursor-vscode',
  'hermes-agent',
  'mcp',
]);
const PROTOCOL = /^\d{4}-\d{2}-\d{2}$/;
/** How many closed sessions, and for how long, a 404 can still be explained by. */
const RECENTLY_CLOSED_LIMIT = 5_000;
const RECENTLY_CLOSED_MS = 60 * 60_000;

/** Process-local pseudonyms: never emit bearer/session IDs, user IDs or arguments. */
export class SessionTelemetry {
  readonly #key = randomBytes(32);
  readonly #entries = new Map<
    string,
    {
      started: number;
      lastRequest: number;
      requests: number;
      toolCalls: number;
      discoveries: number;
      client: string;
      profile: string;
      protocol: string;
    }
  >();
  /** Keyed by sessionRef, oldest first, so no raw session ID outlives its session. */
  readonly #recentlyClosed = new Map<
    string,
    { reason: string; closedAt: number; client: string; profile: string }
  >();
  constructor(
    private readonly emit: (event: string, data: Record<string, unknown>) => void,
    private readonly now = Date.now,
  ) {}
  reference(id: string): string {
    return createHmac('sha256', this.#key).update(id).digest('hex').slice(0, 24);
  }
  start(id: string, name: string | undefined, protocol: unknown): void {
    const client = name?.toLowerCase();
    this.#entries.set(id, {
      started: this.now(),
      lastRequest: this.now(),
      requests: 0,
      toolCalls: 0,
      discoveries: 0,
      client: client && CLIENTS.has(client) ? client : 'other',
      profile: resolveClientProfile(name).name,
      protocol: typeof protocol === 'string' && PROTOCOL.test(protocol) ? protocol : 'unknown',
    });
    this.request(id, 'initialize');
  }
  request(id: string, method: string | readonly string[] | undefined): Record<string, unknown> {
    const entry = this.#entries.get(id);
    if (!entry) return { sessionRef: this.reference(id) };
    entry.requests += 1;
    entry.lastRequest = this.now();
    for (const item of typeof method === 'string' ? [method] : (method ?? [])) {
      if (item === 'tools/call') entry.toolCalls += 1;
      if (['tools/list', 'resources/list', 'server/discover'].includes(item))
        entry.discoveries += 1;
    }
    return {
      sessionRef: this.reference(id),
      sessionRequest: entry.requests,
      clientName: entry.client,
      clientProfile: entry.profile,
      protocol: entry.protocol,
    };
  }
  protocol(id: string, version: string): void {
    const entry = this.#entries.get(id);
    if (entry && PROTOCOL.test(version)) entry.protocol = version;
  }
  close(id: string, reason: string): void {
    const entry = this.#entries.get(id);
    this.#entries.delete(id);
    if (!entry) return;
    this.emit('mcp_session_closed', {
      sessionRef: this.reference(id),
      reason,
      clientName: entry.client,
      clientProfile: entry.profile,
      protocol: entry.protocol,
      requests: entry.requests,
      toolCalls: entry.toolCalls,
      discoveries: entry.discoveries,
      lifetimeMs: this.now() - entry.started,
      idleMs: this.now() - entry.lastRequest,
    });
    this.#rememberClosed(this.reference(id), {
      reason,
      closedAt: this.now(),
      client: entry.client,
      profile: entry.profile,
    });
  }
  /**
   * Why a request named a session it can't use, for the 404 it gets. `other_owner`: the
   * session is live but belongs to another user, client or organization. A close reason
   * (`expired`, `client_delete`, `evicted`, ...): it closed `closedAgoMs` ago. `unknown`:
   * this process never had it, or closed it over an hour ago; a restart looks the same.
   */
  notFound(id: string): Record<string, unknown> {
    const sessionRef = this.reference(id);
    const live = this.#entries.get(id);
    if (live)
      return {
        sessionRef,
        cause: 'other_owner',
        clientName: live.client,
        clientProfile: live.profile,
      };
    const closed = this.#recentlyClosed.get(sessionRef);
    if (!closed || this.now() - closed.closedAt > RECENTLY_CLOSED_MS)
      return { sessionRef, cause: 'unknown' };
    return {
      sessionRef,
      cause: closed.reason,
      closedAgoMs: this.now() - closed.closedAt,
      clientName: closed.client,
      clientProfile: closed.profile,
    };
  }
  #rememberClosed(
    sessionRef: string,
    record: { reason: string; closedAt: number; client: string; profile: string },
  ): void {
    this.#recentlyClosed.delete(sessionRef);
    this.#recentlyClosed.set(sessionRef, record);
    for (const [ref, old] of this.#recentlyClosed) {
      const stale = record.closedAt - old.closedAt > RECENTLY_CLOSED_MS;
      if (!stale && this.#recentlyClosed.size <= RECENTLY_CLOSED_LIMIT) break;
      this.#recentlyClosed.delete(ref);
    }
  }
}
