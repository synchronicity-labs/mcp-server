/** Keys kept for a while, oldest out first. Process-local, like hosted sessions. */
class RecentKeys<T> {
  readonly #entries = new Map<string, { at: number; value: T }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
    private readonly now: () => number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at < this.ttlMs) return entry.value;
    this.#entries.delete(key);
    return undefined;
  }

  set(key: string, value: T): void {
    // Re-inserting moves the key to the back, so the front is always the oldest.
    this.#entries.delete(key);
    this.#entries.set(key, { at: this.now(), value });
    while (this.#entries.size > this.max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

export type Sequence = {
  call_index: number;
  previous_tool?: string;
  ms_since_previous_call?: number;
};

const LIMITS = { repeatWindowMs: 10 * 60_000, conversationTtlMs: 6 * 3_600_000, maxKeys: 20_000 };

/**
 * What the process's telemetry sessions share. ChatGPT and Codex start a new MCP session
 * for nearly every call, so call order and repeat checks have to outlive one session.
 */
export class TelemetryMemory {
  readonly #repeats: RecentKeys<true>;
  readonly #conversations: RecentKeys<{ index: number; tool: string; at: number }>;

  constructor(
    private readonly now: () => number = () => performance.now(),
    limits = LIMITS,
  ) {
    this.#repeats = new RecentKeys(limits.repeatWindowMs, limits.maxKeys, now);
    this.#conversations = new RecentKeys(limits.conversationTtlMs, limits.maxKeys, now);
  }

  /** True the first time a key is seen in a window, false for repeats within it. */
  firstInWindow(key: string): boolean {
    if (this.#repeats.get(key)) return false;
    this.#repeats.set(key, true);
    return true;
  }

  /** Counts a call as the next step of a conversation and returns its place in it. */
  nextInConversation(key: string, tool: string): Sequence {
    const at = this.now();
    const previous = this.#conversations.get(key);
    const index = (previous?.index ?? 0) + 1;
    this.#conversations.set(key, { index, tool, at });
    return {
      call_index: index,
      ...(previous && { previous_tool: previous.tool, ms_since_previous_call: at - previous.at }),
    };
  }
}
