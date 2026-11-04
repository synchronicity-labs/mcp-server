import { describe, expect, it, vi } from 'vitest';
import { pollUntil, progressSender } from './job-wait.js';

describe('pollUntil', () => {
  it('returns as soon as the job is done and reports progress while it runs', async () => {
    const states = ['PENDING', 'PROCESSING', 'COMPLETED'];
    const progress = vi.fn(async () => {});
    const result = await pollUntil(
      async () => states.shift()!,
      (state) => state === 'COMPLETED',
      { progress },
      { describe: (state) => state.toLowerCase(), delayMs: () => 1 },
    );
    expect(result).toBe('COMPLETED');
    expect(progress.mock.calls).toEqual([
      [1, 'pending'],
      [2, 'processing'],
    ]);
  });

  it('returns the latest state when the budget runs out', async () => {
    let clock = 0;
    const read = vi.fn(async () => {
      clock += 30_000;
      return 'PROCESSING';
    });
    const result = await pollUntil(read, () => false, undefined, {
      budgetMs: 50_000,
      delayMs: () => 0,
      now: () => clock,
    });
    expect(result).toBe('PROCESSING');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stops waiting when the call is cancelled', async () => {
    const controller = new AbortController();
    const waiting = pollUntil(
      async () => 'PROCESSING',
      () => false,
      { signal: controller.signal },
      { delayMs: () => 60_000 },
    );
    controller.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
  });
});

describe('progressSender', () => {
  it('sends nothing without a progress token and increasing progress with one', async () => {
    const notify = vi.fn(async () => {});
    await progressSender(undefined, notify)(1);
    expect(notify).not.toHaveBeenCalled();

    const send = progressSender('token-1', notify);
    await send(1, 'importing');
    await send(1);
    const [first, second] = notify.mock.calls.map(
      (call) => (call as unknown as [{ params: { progress: number } }])[0].params,
    );
    expect(first).toEqual({ progressToken: 'token-1', progress: 1, message: 'importing' });
    expect(second!.progress).toBeGreaterThan(first!.progress);
  });
});
