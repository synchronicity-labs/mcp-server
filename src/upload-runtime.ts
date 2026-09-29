import { combineSignals } from './abort-signals.js';

export type UploadRuntimeConfig = {
  maxBytes: number;
  maxConcurrent: number;
  maxQueued: number;
  retryAfterMs: number;
  timeoutMs: number;
};

export type UploadRuntimeStats = {
  active: number;
  queued: number;
  rejected: number;
  completed: number;
  failed: number;
  cleanupFailures: number;
  downloadedBytes: number;
  uploadedBytes: number;
};

const MIB = 1024 * 1024;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getUploadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): UploadRuntimeConfig {
  return {
    maxBytes: positiveInteger(env.MCP_UPLOAD_MAX_BYTES, 512 * MIB),
    maxConcurrent: positiveInteger(env.MCP_UPLOAD_CONCURRENCY, 2),
    maxQueued: nonNegativeInteger(env.MCP_UPLOAD_MAX_QUEUED, 8),
    retryAfterMs: positiveInteger(env.MCP_UPLOAD_RETRY_AFTER_MS, 5_000),
    timeoutMs: positiveInteger(env.MCP_UPLOAD_TIMEOUT_MS, 15 * 60_000),
  };
}

export class UploadOverloadedError extends Error {
  readonly code = 'UPLOAD_CAPACITY_EXCEEDED';
  readonly retryable = true;
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('Upload capacity is temporarily full. Retry the request later.');
    this.name = 'UploadOverloadedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class UploadTimeoutError extends Error {
  readonly code = 'UPLOAD_TIMEOUT';
  readonly retryable = true;
  readonly retryAfterMs: number;

  constructor(timeoutMs: number, retryAfterMs: number) {
    super(`Upload timed out after ${timeoutMs}ms. Retry the request later.`);
    this.name = 'UploadTimeoutError';
    this.retryAfterMs = retryAfterMs;
  }
}

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

export class UploadRuntime {
  readonly config: UploadRuntimeConfig;
  readonly #stats: UploadRuntimeStats = {
    active: 0,
    queued: 0,
    rejected: 0,
    completed: 0,
    failed: 0,
    cleanupFailures: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
  };
  readonly #waiters: Waiter[] = [];

  constructor(config: UploadRuntimeConfig = getUploadRuntimeConfig()) {
    this.config = config;
  }

  async run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new UploadTimeoutError(timeoutMs, this.config.retryAfterMs));
    }, timeoutMs);
    timeout.unref();
    const { signal, dispose } = combineSignals(
      options.signal ? [options.signal, controller.signal] : [controller.signal],
    );
    let release: () => void;
    try {
      release = await this.#acquire(signal);
    } catch (error) {
      clearTimeout(timeout);
      dispose();
      throw error;
    }

    let started = false;
    try {
      signal.throwIfAborted();
      started = true;
      const result = await operation(signal);
      this.#stats.completed += 1;
      return result;
    } catch (error) {
      // Admission cancellation is not a failed transfer: no operation ran.
      if (started) this.#stats.failed += 1;
      throw error;
    } finally {
      clearTimeout(timeout);
      dispose();
      release();
    }
  }

  recordDownloadedBytes(bytes: number): void {
    this.#stats.downloadedBytes += bytes;
  }

  recordUploadedBytes(bytes: number): void {
    this.#stats.uploadedBytes += bytes;
  }

  recordCleanupFailure(): void {
    this.#stats.cleanupFailures += 1;
  }

  snapshot(): UploadRuntimeStats {
    return { ...this.#stats };
  }

  async #acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason;
    if (this.#stats.active < this.config.maxConcurrent) {
      this.#stats.active += 1;
      return this.#releaseOnce();
    }
    if (this.#stats.queued >= this.config.maxQueued) {
      this.#stats.rejected += 1;
      throw new UploadOverloadedError(this.config.retryAfterMs);
    }

    this.#stats.queued += 1;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) {
          this.#waiters.splice(index, 1);
          this.#stats.queued -= 1;
        }
        reject(signal.reason);
      };
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => signal.removeEventListener('abort', onAbort),
      };
      this.#waiters.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.#waiters.shift();
      if (waiter) {
        this.#stats.queued -= 1;
        waiter.cleanup();
        waiter.resolve(this.#releaseOnce());
        return;
      }
      this.#stats.active = Math.max(0, this.#stats.active - 1);
    };
  }
}

export const uploadRuntime = new UploadRuntime();
