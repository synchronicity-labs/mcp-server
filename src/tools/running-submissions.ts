import { createHash } from 'node:crypto';
import { getAuthOwner, getAuthToken } from '../auth/async-context.js';
import { ApiRequestError, type HttpClient } from '../http-client.js';

// Agents resubmit a request every few seconds while its generation is still rendering,
// uploading the same files again each time. A free plan runs one generation at a time,
// so every resubmission failed with concurrency_limit_reached. Answer an identical
// request from the same user with the generation that is still running instead.
const REMEMBER_MS = 30 * 60_000;
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'REJECTED', 'CANCELED', 'CANCELLED']);

type Entry = { expires: number } & (
  | { submitting: Promise<unknown>; id?: never }
  | { id: string; submitting?: never }
);

export type RunningSubmissions = {
  /** Runs `submit` unless an identical request is still submitting or rendering. */
  once: (
    request: unknown,
    submit: () => Promise<unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
};

function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createRunningSubmissions(http: HttpClient): RunningSubmissions {
  const entries = new Map<string, Entry>();
  const keyOf = (request: unknown) => {
    const owner =
      getAuthOwner() ??
      createHash('sha256')
        .update(getAuthToken() ?? '')
        .digest('hex');
    return createHash('sha256')
      .update(JSON.stringify([owner, request]))
      .digest('hex');
  };

  // A failed read leaves the entry in place: the generation may still be running.
  async function stillRunning(id: string, signal?: AbortSignal): Promise<unknown> {
    try {
      const generation = await http.request('get', `/v2/generate/${encodeURIComponent(id)}`, {
        signal,
      });
      const status = (generation as { status?: unknown } | null)?.status;
      return typeof status === 'string' && !TERMINAL_STATUSES.has(status) ? generation : undefined;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return undefined;
      throw error;
    }
  }

  return {
    async once(request, submit, signal) {
      const key = keyOf(request);
      const entry = entries.get(key);
      if (entry && entry.expires > Date.now()) {
        // A failed or uncertain first attempt is the answer for every call that waited on it.
        if (entry.submitting) return untilAborted(entry.submitting, signal);
        const generation = await stillRunning(entry.id, signal);
        if (generation) return generation;
        // Another identical call may have started a submission during the read.
        const current = entries.get(key);
        if (current?.submitting) return untilAborted(current.submitting, signal);
      }
      if (entries.get(key) === entry) entries.delete(key);

      const now = Date.now();
      for (const [other, { expires }] of entries) if (expires <= now) entries.delete(other);
      const submitting = submit();
      const reservation: Entry = { submitting, expires: now + REMEMBER_MS };
      entries.set(key, reservation);
      try {
        const generation = await submitting;
        const id = (generation as { id?: unknown } | null)?.id;
        if (entries.get(key) === reservation) {
          if (typeof id === 'string') entries.set(key, { id, expires: Date.now() + REMEMBER_MS });
          else entries.delete(key);
        }
        return generation;
      } catch (error) {
        if (entries.get(key) === reservation) entries.delete(key);
        throw error;
      }
    },
  };
}
