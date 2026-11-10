import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../http-client.js';
import type { JsonSchema } from '../openapi/types.js';
import { referralCollectorSchema } from '../test-fixtures/telemetry.js';
import { createTelemetryQueue, MCP_EVENTS_OPERATION_ID, MCP_EVENTS_PATH } from './index.js';
import type { TelemetryEvent } from './queue.js';

const legacy = { operationId: MCP_EVENTS_OPERATION_ID };
const collector = (schema: JsonSchema) => ({
  ...legacy,
  requestBody: { contentType: 'application/json', schema },
});
const supported = collector(referralCollectorSchema());
const event: TelemetryEvent = {
  event: 'mcp_tool_called',
  event_id: 'e1',
  timestamp: new Date(0).toISOString(),
  properties: { tool_name: 'dubbing_create', referral_source: 'glama' },
};
const withoutReferral = { ...event, properties: { tool_name: 'dubbing_create' } };
const mockHttp = () => ({ request: vi.fn<HttpClient['request']>(async () => ({})) });

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('createTelemetryQueue', () => {
  it('is active at once when the API lists the collector, and absent when off', () => {
    const http = mockHttp();
    const recheck = vi.fn(async () => supported);
    expect(createTelemetryQueue(true, [legacy], http)?.active).toBe(true);
    expect(createTelemetryQueue(false, [legacy], http, recheck)).toBeUndefined();
    expect(createTelemetryQueue(true, [], http)).toBeUndefined();
    expect(recheck).not.toHaveBeenCalled();
  });

  it.each([
    ['missing request body', legacy],
    ['missing schema properties', collector({})],
    ['malformed variants', collector({ properties: { events: { items: { oneOf: null } } } })],
    ['only session support', collector(referralCollectorSchema(['mcp_session_initialized']))],
    ['only tool support', collector(referralCollectorSchema(['mcp_tool_called']))],
    ['wrong property type', collector(referralCollectorSchema(undefined, { type: 'number' }))],
    ['unbounded source', collector(referralCollectorSchema(undefined, { type: 'string' }))],
    [
      'wrong source pattern',
      collector(referralCollectorSchema(undefined, { type: 'string', pattern: '.*' })),
    ],
    [
      'required source',
      collector(referralCollectorSchema(undefined, undefined, ['referral_source'])),
    ],
    ['unrelated event', collector(referralCollectorSchema(['other_event']))],
  ])('keeps legacy events unchanged for %s', async (_name, operation) => {
    vi.useFakeTimers();
    const http = mockHttp();
    const queue = createTelemetryQueue(true, [operation], http)!;
    queue.record('owner', 'token', event);
    queue.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(http.request).toHaveBeenCalledExactlyOnceWith('post', MCP_EVENTS_PATH, {
      body: { events: [withoutReferral] },
      signal: expect.any(AbortSignal),
    });
  });

  it.each([undefined, ['session_id']])(
    'sends the source once both event variants accept it, with required list %j',
    async (required) => {
      vi.useFakeTimers();
      const http = mockHttp();
      const operation = collector(referralCollectorSchema(undefined, undefined, required));
      const recheck = vi.fn(async () => supported);
      const queue = createTelemetryQueue(true, [operation], http, recheck)!;
      const init = { ...event, event: 'mcp_session_initialized' as const, event_id: 'e2' };
      queue.record('owner', 'token', init);
      queue.record('owner', 'token', event);
      queue.flush();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(http.request).toHaveBeenCalledExactlyOnceWith('post', MCP_EVENTS_PATH, {
        body: { events: [init, event] },
        signal: expect.any(AbortSignal),
      });
      expect(recheck).not.toHaveBeenCalled();
    },
  );

  it('activates base telemetry first, upgrades referral later, and never replays old events', async () => {
    vi.useFakeTimers();
    const http = mockHttp();
    const recheck = vi
      .fn<() => Promise<typeof legacy | undefined>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(legacy)
      .mockResolvedValueOnce(supported);
    const queue = createTelemetryQueue(true, [], http, recheck)!;
    queue.record('owner', 'token', { ...event, event_id: 'dropped' });
    expect(queue.stats()).toMatchObject({ active: false, queued: 0 });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(queue.active).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(queue.active).toBe(true);
    queue.record('owner', 'token', event);
    queue.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(http.request.mock.calls[0]?.[2]?.body).toEqual({ events: [withoutReferral] });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    queue.record('owner', 'token', { ...event, event_id: 'supported' });
    queue.flush();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(recheck).toHaveBeenCalledTimes(4);
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(http.request.mock.calls[1]?.[2]?.body).toEqual({
      events: [{ ...event, event_id: 'supported' }],
    });
  });

  it('keeps sending legacy events after a failed referral recheck, then upgrades', async () => {
    vi.useFakeTimers();
    const http = mockHttp();
    const recheck = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(supported);
    const queue = createTelemetryQueue(true, [legacy], http, recheck, 1000)!;
    await vi.advanceTimersByTimeAsync(1000);
    queue.record('owner', 'token', event);
    queue.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(http.request.mock.calls[0]?.[2]?.body).toEqual({ events: [withoutReferral] });
    await vi.advanceTimersByTimeAsync(1000);
    queue.record('owner', 'token', event);
    queue.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(http.request.mock.calls[1]?.[2]?.body).toEqual({ events: [event] });
  });
});
