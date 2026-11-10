import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../http-client.js';
import { createTelemetryQueue, MCP_EVENTS_OPERATION_ID } from './index.js';

const http = { request: vi.fn(async () => ({})) } as unknown as HttpClient;
const listed = [{ operationId: MCP_EVENTS_OPERATION_ID }];
const event = {
  event: 'mcp_tool_called' as const,
  event_id: 'e1',
  timestamp: new Date(0).toISOString(),
  properties: {},
};

afterEach(() => {
  vi.useRealTimers();
});

describe('createTelemetryQueue', () => {
  it('is active at once when the API already lists the collector, and absent when off', () => {
    expect(createTelemetryQueue(true, listed, http)?.active).toBe(true);
    expect(createTelemetryQueue(false, listed, http, async () => true)).toBeUndefined();
    expect(createTelemetryQueue(true, [], http)).toBeUndefined();
  });

  it('waits for an API that deploys after the server, then turns on without a restart', async () => {
    vi.useFakeTimers();
    const answers = [() => Promise.reject(new Error('down')), () => Promise.resolve(false)];
    const recheck = vi.fn(() => (answers.shift() ?? (() => Promise.resolve(true)))());
    const queue = createTelemetryQueue(true, [], http, recheck, 1000)!;
    queue.record('owner', 'token', event);
    expect(queue.stats()).toMatchObject({ active: false, queued: 0 });

    await vi.advanceTimersByTimeAsync(2000);
    expect(queue.active).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.active).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(recheck).toHaveBeenCalledTimes(3);

    queue.record('owner', 'token', event);
    expect(queue.stats()).toMatchObject({ active: true, queued: 1 });
  });
});
