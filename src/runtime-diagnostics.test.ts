import { describe, expect, it } from 'vitest';
import { HttpRequestMetrics, serializeError } from './runtime-diagnostics.js';

describe('HTTP request metrics', () => {
  it('tracks concurrent requests, delivered status classes, and completion idempotency', () => {
    const metrics = new HttpRequestMetrics();

    const finishOk = metrics.start();
    const finishError = metrics.start();
    expect(metrics.snapshot()).toMatchObject({ total: 2, inFlight: 2, completed: 0 });

    finishOk({ statusCode: 200, aborted: false, responseDelivered: true, durationMs: 12 });
    finishError({ statusCode: 503, aborted: false, responseDelivered: true, durationMs: 34 });
    finishError({ statusCode: 503, aborted: false, responseDelivered: true, durationMs: 34 });

    expect(metrics.snapshot()).toEqual({
      total: 2,
      inFlight: 0,
      completed: 2,
      aborted: 0,
      status2xx: 1,
      status3xx: 0,
      status4xx: 0,
      status5xx: 1,
      durationMsTotal: 46,
      durationMsMax: 34,
    });
  });

  it('excludes aborted requests without a delivered response from status buckets', () => {
    const metrics = new HttpRequestMetrics();

    metrics.start()({ statusCode: 200, aborted: true, responseDelivered: false, durationMs: 7 });

    expect(metrics.snapshot()).toMatchObject({
      completed: 1,
      aborted: 1,
      status2xx: 0,
      status3xx: 0,
      status4xx: 0,
      status5xx: 0,
    });
  });
});

describe('error serialization', () => {
  it('preserves error identity and stack without throwing on non-errors', () => {
    const error = new TypeError('boom');
    expect(serializeError(error)).toMatchObject({
      name: 'TypeError',
      message: 'boom',
      stack: expect.stringContaining('TypeError: boom'),
    });
    expect(serializeError({ reason: 'unknown' })).toEqual({ message: '[object Object]' });
  });
});
