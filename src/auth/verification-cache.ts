import { createHash } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { VerificationUnavailableError, verifySyncAccessToken } from './token-verification.js';

export const VERIFICATION_CACHE_MS = 15_000;
const MAX_ENTRIES = 512;
const MAX_PENDING = 128;
type Pending = { promise: Promise<AuthInfo>; controller: AbortController; waiters: number };

/** Provider-scoped cache: successful checks only, bounded by both TTL and token expiry. */
export function createTokenVerifier(apiBaseUrl: string) {
  const cache = new Map<string, { info: AuthInfo; until: number }>();
  const pending = new Map<string, Pending>();
  let epoch = 0;
  let cooldownUntil = 0;

  function clear() {
    epoch++;
    cache.clear();
    cooldownUntil = 0;
    for (const entry of pending.values()) entry.controller.abort();
    pending.clear();
  }

  async function verify(token: string, signal?: AbortSignal): Promise<AuthInfo> {
    if (signal?.aborted) throw new VerificationUnavailableError();
    const key = createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.until > now) {
      cache.delete(key);
      cache.set(key, cached);
      return structuredClone(cached.info);
    }
    cache.delete(key);
    if (cooldownUntil > now)
      throw new VerificationUnavailableError(429, String(Math.ceil((cooldownUntil - now) / 1000)));
    let entry = pending.get(key);
    if (!entry) {
      if (pending.size >= MAX_PENDING) throw new VerificationUnavailableError(503, '1');
      const controller = new AbortController();
      const startedEpoch = epoch;
      entry = { controller, waiters: 0, promise: Promise.resolve({} as AuthInfo) };
      const current = entry;
      entry.promise = verifySyncAccessToken(apiBaseUrl, token, controller.signal)
        .then((info) => {
          const until = Math.min(now + VERIFICATION_CACHE_MS, (info.expiresAt ?? 0) * 1000);
          if (!controller.signal.aborted && epoch === startedEpoch && until > Date.now()) {
            for (const [cacheKey, value] of cache)
              if (value.until <= Date.now()) cache.delete(cacheKey);
            if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
            cache.set(key, { info: structuredClone(info), until });
          }
          return info;
        })
        .catch((error: unknown) => {
          if (error instanceof VerificationUnavailableError && error.status === 429) {
            const delay = error.retryAfter
              ? /^\d+$/.test(error.retryAfter)
                ? Number(error.retryAfter) * 1000
                : Date.parse(error.retryAfter) - Date.now()
              : 1000;
            cooldownUntil = Math.max(cooldownUntil, Date.now() + Math.max(1000, delay));
          }
          throw error;
        })
        .finally(() => {
          if (pending.get(key) === current) pending.delete(key);
        });
      pending.set(key, entry);
    }
    // Cancelling one HTTP request must not cancel another caller's shared check.
    entry.waiters++;
    const current = entry;
    return new Promise<AuthInfo>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, info?: AuthInfo) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        current.waiters--;
        if (current.waiters === 0 && pending.get(key) === current) {
          pending.delete(key);
          current.controller.abort();
        }
        if (error) reject(error);
        else resolve(structuredClone(info!));
      };
      const abort = () => finish(new VerificationUnavailableError());
      signal?.addEventListener('abort', abort, { once: true });
      current.promise.then(
        (info) => finish(undefined, info),
        (error: unknown) => finish(error),
      );
      if (signal?.aborted) abort();
    });
  }
  return { verify, clear };
}
