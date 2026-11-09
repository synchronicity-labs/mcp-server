import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { type TelemetryEvent, TelemetryQueue } from './queue.js';

const event = (n: number): TelemetryEvent => ({
  event: 'mcp_tool_called',
  event_id: `e${n}`,
  timestamp: new Date(0).toISOString(),
  properties: { n },
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('TelemetryQueue', () => {
  it('batches per owner with that owner’s latest token and forgets it once sent', async () => {
    const sent: { token?: string; ids: string[] }[] = [];
    const queue = new TelemetryQueue(
      async (events, token) => void sent.push({ token, ids: events.map((e) => e.event_id) }),
      { maxEvents: 100, batchSize: 2, flushMs: 60_000, maxInFlight: 8 },
    );
    queue.record('alice', 'a1', event(1));
    queue.record('bob', 'b1', event(2));
    queue.record('alice', 'a2', event(3)); // fills alice's batch
    await settle();
    expect(sent).toEqual([{ token: 'a2', ids: ['e1', 'e3'] }]);
    queue.flush();
    await settle();
    expect(sent[1]).toEqual({ token: 'b1', ids: ['e2'] });
    expect(queue.stats()).toMatchObject({ queued: 3, sent: 3, pending: 0, inFlight: 0 });
  });

  it('drops events past its bound and counts failures without throwing', async () => {
    const queue = new TelemetryQueue(
      () => {
        throw new Error('down');
      },
      { maxEvents: 2, batchSize: 50, flushMs: 60_000, maxInFlight: 8 },
    );
    for (let n = 0; n < 5; n += 1) queue.record('o', 't', event(n));
    expect(queue.stats()).toMatchObject({ queued: 2, dropped: 3, pending: 2 });
    expect(() => queue.flush()).not.toThrow();
    await settle();
    expect(queue.stats()).toMatchObject({ failed: 2, pending: 0, inFlight: 0 });
  });

  it('keeps events while the in-flight cap is reached, then sends them', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const batches: number[] = [];
    const queue = new TelemetryQueue(
      async (events) => {
        batches.push(events.length);
        await gate;
      },
      { maxEvents: 100, batchSize: 1, flushMs: 60_000, maxInFlight: 1 },
    );
    queue.record('o', 't', event(1));
    queue.record('o', 't', event(2));
    expect(queue.stats()).toMatchObject({ inFlight: 1, pending: 1 });
    release();
    await settle();
    queue.flush();
    await settle();
    expect(batches).toEqual([1, 1]);
  });

  it('sends outside the recording request’s async context', async () => {
    const request = new AsyncLocalStorage<string>();
    const seen: (string | undefined)[] = [];
    const queue = new TelemetryQueue(async () => void seen.push(request.getStore()), {
      maxEvents: 100,
      batchSize: 1,
      flushMs: 60_000,
      maxInFlight: 8,
    });
    request.run('organization-of-this-request', () => queue.record('o', 't', event(1)));
    await settle();
    expect(seen).toEqual([undefined]);
  });

  it('flushes on its timer without holding the process open', async () => {
    const sent: number[] = [];
    const queue = new TelemetryQueue(async (events) => void sent.push(events.length), {
      maxEvents: 100,
      batchSize: 50,
      flushMs: 10,
      maxInFlight: 8,
    });
    queue.record('o', 't', event(1));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sent).toEqual([1]);
  });
});
