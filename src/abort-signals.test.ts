import { describe, expect, it, vi } from 'vitest';
import { combineSignals } from './abort-signals.js';

describe('portable cancellation composition', () => {
  it('preserves the first cancellation reason and removes every listener', () => {
    const first = new AbortController();
    const second = new AbortController();
    const removeFirst = vi.spyOn(first.signal, 'removeEventListener');
    const removeSecond = vi.spyOn(second.signal, 'removeEventListener');
    const combined = combineSignals([first.signal, second.signal]);
    const reason = new Error('explicit cancel');
    second.abort(reason);
    first.abort(new Error('later deadline'));
    expect(combined.signal.reason).toBe(reason);
    expect(removeFirst).toHaveBeenCalledOnce();
    expect(removeSecond).toHaveBeenCalledOnce();
    combined.dispose();
    expect(removeFirst).toHaveBeenCalledOnce();
  });

  it('handles pre-cancellation and disposes completed operations without aborting them', () => {
    const reason = new Error('already cancelled');
    expect(combineSignals([AbortSignal.abort(reason)]).signal.reason).toBe(reason);
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    const combined = combineSignals([parent.signal]);
    combined.dispose();
    parent.abort();
    expect(remove).toHaveBeenCalledOnce();
    expect(combined.signal.aborted).toBe(false);
  });
});
