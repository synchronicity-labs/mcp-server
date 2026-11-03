import { createHash } from 'node:crypto';
import { getAuthOwner, getAuthToken } from '../auth/async-context.js';
import type { HttpClient } from '../http-client.js';

// Agents resubmit a request every few seconds while its generation is still rendering,
// uploading the same files again each time. A free plan runs one generation at a time,
// so every resubmission failed with concurrency_limit_reached. Answer an identical
// request from the same user with the generation that is still running instead.
const REMEMBER_MS = 30 * 60_000;
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'REJECTED', 'CANCELED', 'CANCELLED']);

export type RunningSubmissions = {
  running: (request: unknown, signal?: AbortSignal) => Promise<unknown>;
  remember: (request: unknown, generation: unknown) => void;
};

export function createRunningSubmissions(http: HttpClient): RunningSubmissions {
  const submissions = new Map<string, { id: string; expires: number }>();
  const key = (request: unknown) => {
    const owner =
      getAuthOwner() ??
      createHash('sha256')
        .update(getAuthToken() ?? '')
        .digest('hex');
    return createHash('sha256')
      .update(JSON.stringify([owner, request]))
      .digest('hex');
  };

  return {
    async running(request, signal) {
      const submission = key(request);
      const entry = submissions.get(submission);
      if (!entry) return undefined;
      if (entry.expires > Date.now()) {
        try {
          const generation = await http.request(
            'get',
            `/v2/generate/${encodeURIComponent(entry.id)}`,
            { signal },
          );
          const status = (generation as { status?: unknown } | null)?.status;
          if (typeof status === 'string' && !TERMINAL_STATUSES.has(status)) return generation;
        } catch {
          // An unreadable generation is no reason to block a new submission.
          signal?.throwIfAborted();
        }
      }
      submissions.delete(submission);
      return undefined;
    },
    remember(request, generation) {
      const id = (generation as { id?: unknown } | null)?.id;
      if (typeof id !== 'string') return;
      const now = Date.now();
      for (const [submission, entry] of submissions)
        if (entry.expires <= now) submissions.delete(submission);
      submissions.set(key(request), { id, expires: now + REMEMBER_MS });
    },
  };
}
