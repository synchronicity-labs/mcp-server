import { AsyncLocalStorage } from 'node:async_hooks';

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
 */
export class TelemetryQueue {
  readonly #buckets = new Map<string, Bucket>();
  readonly #stats: TelemetryStats = { queued: 0, sent: 0, dropped: 0, failed: 0 };
  // Sends run outside the recording request, so its organization and analytics headers stay out.
  readonly #detached = AsyncLocalStorage.snapshot();
  #size = 0;
  #inFlight = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly send: TelemetrySend,
    private readonly limits = LIMITS,
  ) {}

  record(owner: string, token: string | undefined, event: TelemetryEvent): void {
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

  stats(): TelemetryStats & { pending: number; inFlight: number } {
    return { ...this.#stats, pending: this.#size, inFlight: this.#inFlight };
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
    if (!bucket || this.#inFlight >= this.limits.maxInFlight) return;
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
        }),
    );
  }
}
