import { AsyncLocalStorage } from 'node:async_hooks';
import { TelemetryMemory } from './memory.js';

export type TelemetryEvent = {
  event: 'mcp_session_initialized' | 'mcp_tool_called';
  event_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
};

export type TelemetrySend = (
  events: TelemetryEvent[],
  token: string | undefined,
) => Promise<unknown>;

export type TelemetryStats = { queued: number; sent: number; dropped: number; failed: number };

type Bucket = { token: string | undefined; events: TelemetryEvent[] };

const LIMITS = { maxEvents: 2000, batchSize: 50, flushMs: 2000, maxInFlight: 8 };

/**
 * Batches events per verified owner and sends them with that owner's credential.
 * Recording never waits or throws. A bucket keeps its token only while it has events.
 * An inactive queue, waiting for the API to collect MCP events, records nothing.
 */
export class TelemetryQueue {
  /** Call order and repeat checks that outlive a single session. */
  readonly memory = new TelemetryMemory();
  readonly #buckets = new Map<string, Bucket>();
  readonly #stats: TelemetryStats = { queued: 0, sent: 0, dropped: 0, failed: 0 };
  // Sends run outside the recording request, so its organization and analytics headers stay out.
  readonly #detached = AsyncLocalStorage.snapshot();
  #size = 0;
  #inFlight = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  // Set when a flush found every send slot busy, so the next finished send resumes it.
  #blocked = false;
  #active: boolean;

  constructor(
    private readonly send: TelemetrySend,
    private readonly limits = LIMITS,
    active = true,
  ) {
    this.#active = active;
  }

  get active(): boolean {
    return this.#active;
  }

  activate(): void {
    this.#active = true;
  }

  record(owner: string, token: string | undefined, event: TelemetryEvent): void {
    if (!this.#active) return;
    if (this.#size >= this.limits.maxEvents) {
      this.#stats.dropped += 1;
      return;
    }
    let bucket = this.#buckets.get(owner);
    if (!bucket) {
      bucket = { token, events: [] };
      this.#buckets.set(owner, bucket);
    }
    if (token) bucket.token = token;
    bucket.events.push(event);
    this.#size += 1;
    this.#stats.queued += 1;
    if (bucket.events.length >= this.limits.batchSize) this.#flushOwner(owner);
    this.#schedule();
  }

  /** Sends everything pending now, for shutdown. Still never waits for the API. */
  flush(): void {
    for (const owner of this.#buckets.keys()) this.#flushOwner(owner);
  }

  stats(): TelemetryStats & { active: boolean; pending: number; inFlight: number } {
    return { ...this.#stats, active: this.#active, pending: this.#size, inFlight: this.#inFlight };
  }

  #schedule(): void {
    if (this.#timer || this.#size === 0) return;
    this.#timer = this.#detached(() =>
      setTimeout(() => {
        this.#timer = undefined;
        this.flush();
        this.#schedule();
      }, this.limits.flushMs),
    );
    this.#timer.unref?.();
  }

  #flushOwner(owner: string): void {
    const bucket = this.#buckets.get(owner);
    if (!bucket) return;
    if (this.#inFlight >= this.limits.maxInFlight) {
      this.#blocked = true;
      return;
    }
    const batch = bucket.events.splice(0, this.limits.batchSize);
    const { token } = bucket;
    if (bucket.events.length === 0) this.#buckets.delete(owner);
    this.#size -= batch.length;
    this.#inFlight += 1;
    // Starting inside then() turns a synchronous throw into a counted failure.
    void this.#detached(() =>
      Promise.resolve()
        .then(() => this.send(batch, token))
        .then(
          () => {
            this.#stats.sent += batch.length;
          },
          () => {
            this.#stats.failed += batch.length;
          },
        )
        .finally(() => {
          this.#inFlight -= 1;
          if (this.#blocked) {
            this.#blocked = false;
            this.flush();
          }
        }),
    );
  }
}
