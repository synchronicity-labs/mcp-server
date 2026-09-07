import { describe, expect, it } from 'vitest';
import {
  getUploadRuntimeConfig,
  type UploadOverloadedError,
  UploadRuntime,
} from './upload-runtime.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('upload runtime', () => {
  it('loads bounded upload settings from the process environment', () => {
    expect(
      getUploadRuntimeConfig({
        MCP_UPLOAD_MAX_BYTES: '123',
        MCP_UPLOAD_CONCURRENCY: '4',
        MCP_UPLOAD_MAX_QUEUED: '7',
        MCP_UPLOAD_RETRY_AFTER_MS: '9000',
        MCP_UPLOAD_TIMEOUT_MS: '12000',
      }),
    ).toEqual({
      maxBytes: 123,
      maxConcurrent: 4,
      maxQueued: 7,
      retryAfterMs: 9_000,
      timeoutMs: 12_000,
    });
  });

  it('queues up to the configured concurrency and rejects excess work as retryable', async () => {
    const runtime = new UploadRuntime({
      maxBytes: 100,
      maxConcurrent: 1,
      maxQueued: 1,
      retryAfterMs: 2_500,
      timeoutMs: 10_000,
    });
    const firstGate = deferred();
    const first = runtime.run(() => firstGate.promise);
    const second = runtime.run(async () => undefined);

    await expect(runtime.run(async () => undefined)).rejects.toMatchObject({
      name: 'UploadOverloadedError',
      code: 'UPLOAD_CAPACITY_EXCEEDED',
      retryable: true,
      retryAfterMs: 2_500,
    } satisfies Partial<UploadOverloadedError>);
    expect(runtime.snapshot()).toMatchObject({ active: 1, queued: 1, rejected: 1 });

    firstGate.resolve();
    await Promise.all([first, second]);
    expect(runtime.snapshot()).toEqual({
      active: 0,
      queued: 0,
      rejected: 1,
      completed: 2,
      failed: 0,
      cleanupFailures: 0,
      downloadedBytes: 0,
      uploadedBytes: 0,
    });
  });

  it('tracks downloaded and durably uploaded bytes', async () => {
    const runtime = new UploadRuntime({
      maxBytes: 100,
      maxConcurrent: 1,
      maxQueued: 0,
      retryAfterMs: 1_000,
      timeoutMs: 10_000,
    });

    await runtime.run(async () => {
      runtime.recordDownloadedBytes(12);
      runtime.recordUploadedBytes(12);
    });

    expect(runtime.snapshot()).toMatchObject({
      completed: 1,
      downloadedBytes: 12,
      uploadedBytes: 12,
    });
  });

  it('aborts timed-out work and releases capacity for the next upload', async () => {
    const runtime = new UploadRuntime({
      maxBytes: 100,
      maxConcurrent: 1,
      maxQueued: 1,
      retryAfterMs: 1_000,
      timeoutMs: 10,
    });
    let aborted = false;

    await expect(
      runtime.run(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      ),
    ).rejects.toMatchObject({ name: 'UploadTimeoutError', code: 'UPLOAD_TIMEOUT' });

    expect(aborted).toBe(true);
    await expect(runtime.run(async () => 'next')).resolves.toBe('next');
    expect(runtime.snapshot().active).toBe(0);
  });

  it('removes a timed-out waiter from the queue', async () => {
    const runtime = new UploadRuntime({
      maxBytes: 100,
      maxConcurrent: 1,
      maxQueued: 1,
      retryAfterMs: 1_000,
      timeoutMs: 10,
    });
    const firstGate = deferred();
    const first = runtime.run(async () => firstGate.promise);

    await expect(runtime.run(async () => 'queued')).rejects.toMatchObject({
      name: 'UploadTimeoutError',
      code: 'UPLOAD_TIMEOUT',
    });
    expect(runtime.snapshot()).toMatchObject({ active: 1, queued: 0 });

    firstGate.resolve();
    await first;
    await expect(runtime.run(async () => 'replacement')).resolves.toBe('replacement');
  });
});
