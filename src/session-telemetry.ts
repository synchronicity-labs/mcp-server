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
  'hermes-agent',
  'mcp',
]);
const PROTOCOL = /^\d{4}-\d{2}-\d{2}$/;

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
  request(id: string, method: string | undefined): Record<string, unknown> {
    const entry = this.#entries.get(id);
    if (!entry) return { sessionRef: this.reference(id) };
    entry.requests += 1;
    entry.lastRequest = this.now();
    if (method === 'tools/call') entry.toolCalls += 1;
    if (['tools/list', 'resources/list', 'server/discover'].includes(method ?? ''))
      entry.discoveries += 1;
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
  }
}
