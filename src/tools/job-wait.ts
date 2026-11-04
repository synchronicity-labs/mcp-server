import { z } from 'zod';
import type { ToolRequestContext } from './generator.js';

/**
 * Server-side waiting for the job tools. Agents otherwise write the same poll loop for
 * every job type, and agent gateways pause servers that answer identical calls with
 * identical "still running" results. One call with wait: true holds for up to
 * WAIT_BUDGET_MS, sends progress notifications when the caller asked for them, and returns
 * the latest state either way, so a still-running job just means calling again.
 */
export const WAIT_BUDGET_MS = 50_000;
// Back off 1, 2, 4 then every 5 seconds, so quick jobs return quickly.
const INTERVALS_MS = [1_000, 2_000, 4_000, 5_000];

export const waitInput = z
  .boolean()
  .optional()
  .describe(
    'Wait on the server until the job finishes or about 50 seconds pass, then return its latest state. If it is still running, call again with wait: true instead of sleeping.',
  );

type Notify = (notification: {
  method: 'notifications/progress';
  params: { progressToken: string | number; progress: number; message?: string };
}) => Promise<void>;

export function progressSender(
  token: unknown,
  notify: Notify,
): (progress: number, message?: string) => Promise<void> {
  if (typeof token !== 'string' && typeof token !== 'number') return async () => {};
  let last = -1;
  return async (progress, message) => {
    // The spec requires progress to increase with every notification.
    const value = Math.max(progress, last + 1e-6);
    last = value;
    await notify({
      method: 'notifications/progress',
      params: { progressToken: token, progress: value, ...(message ? { message } : {}) },
    }).catch(() => {});
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Read until done(state) or the budget runs out; returns the last state read.
 * `describe` turns a state into the progress message; `delayMs` lets a pending
 * state ask for a longer pause (an import's retryAfterMs).
 *
 * The budget bounds the whole call: no pause runs past it, and every read after
 * the first gets a signal that aborts at the deadline, in which case the last
 * state is returned. Only the caller's own cancellation is rethrown.
 */
export async function pollUntil<T>(
  read: (signal?: AbortSignal) => Promise<T>,
  done: (state: T) => boolean,
  context: ToolRequestContext | undefined,
  options: {
    describe?: (state: T) => string;
    delayMs?: (state: T) => number | undefined;
    budgetMs?: number;
    now?: () => number;
  } = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? WAIT_BUDGET_MS);
  let state = await read(context?.signal);
  for (let polls = 1; !done(state); polls++) {
    await context?.progress?.(polls, options.describe?.(state));
    const pause =
      options.delayMs?.(state) ?? INTERVALS_MS[Math.min(polls, INTERVALS_MS.length) - 1]!;
    // Sleeping into the deadline only to return the same state helps nobody.
    if (deadline - now() <= pause) return state;
    await sleep(pause, context?.signal);
    const next = await boundedBy(deadline - now(), context?.signal, read);
    if (next === TIMED_OUT) return state;
    state = next;
  }
  return state;
}

export const TIMED_OUT = Symbol('timed out');

/** Run `task` with a signal that also aborts after `ms`; a timeout yields TIMED_OUT. */
export async function boundedBy<T>(
  ms: number,
  caller: AbortSignal | undefined,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T | typeof TIMED_OUT> {
  const timeout = AbortSignal.timeout(Math.max(ms, 0));
  try {
    return await task(caller ? AbortSignal.any([caller, timeout]) : timeout);
  } catch (error) {
    if (timeout.aborted && !caller?.aborted) return TIMED_OUT;
    throw error;
  }
}
