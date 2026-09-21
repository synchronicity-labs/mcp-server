import { access, mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../http-client.js';
import { UploadRuntime } from '../upload-runtime.js';
import { createAppTools } from './app-tools.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('upload and generation write boundaries', () => {
  it.each([
    'download',
    'presign',
    'put',
    'register',
  ])('cancels at %s without subsequent writes and cleans temporary resources', async (stage) => {
    const cancel = new AbortController();
    const uploads = new UploadRuntime({
      maxBytes: 100,
      maxConcurrent: 1,
      maxQueued: 1,
      timeoutMs: 10_000,
      retryAfterMs: 1000,
    });
    const writes: string[] = [];
    const stopAt = (current: string) => {
      if (current === stage) cancel.abort(new Error('explicit cancellation'));
    };
    const fetchMock = vi.fn(
      async (_url: string, options?: RequestInit & { body?: AsyncIterable<Uint8Array> }) => {
        if (options?.method === 'PUT') {
          if (options.body) for await (const _chunk of options.body) void _chunk;
          writes.push('put');
          stopAt('put');
          return new Response(null, { status: 200 });
        }
        stopAt('download');
        return new Response(new Uint8Array(8), {
          headers: { 'content-type': 'video/mp4', 'content-length': '8' },
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const request = vi.fn<HttpClient['request']>(async (method, path, options) => {
      expect(options?.signal).toBeDefined();
      expect(options?.signal?.aborted).toBe(false);
      if (path === '/v2/projects')
        return { items: [{ id: 'project', name: 'ChatGPT generations' }] };
      if (path === '/v2/assets/upload') {
        writes.push('presign');
        stopAt('presign');
        return { uploadUrl: 'https://storage.test/upload', url: 'https://storage.test/file' };
      }
      if (path === '/v2/assets') {
        writes.push('register');
        stopAt('register');
        return { id: 'asset' };
      }
      throw new Error(`unexpected request ${method} ${path}`);
    });
    const tool = createAppTools({ request }, uploads).find(
      (tool) => tool.name === 'create-lipsync',
    );
    if (!tool) throw new Error('missing create-lipsync');
    await expect(
      tool.handler(
        {
          audioAssetId: 'audio',
          video: { download_url: 'https://media.test/video', file_id: 'video' },
        },
        { signal: cancel.signal },
      ),
    ).rejects.toThrow(/cancellation|aborted/);
    const stages = ['download', 'presign', 'put', 'register'];
    expect(writes).toEqual(stages.slice(1, stages.indexOf(stage) + 1));
    expect(uploads.snapshot()).toMatchObject({ active: 0, queued: 0 });
    for (const result of vi.mocked(mkdtemp).mock.results) {
      await expect(access(await result.value)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('stops after project creation when cancellation arrives with its response', async () => {
    const cancel = new AbortController();
    const request = vi.fn<HttpClient['request']>(async (method, path) => {
      if (path !== '/v2/projects') throw new Error('unexpected generation');
      if (method === 'get') return { items: [] };
      cancel.abort(new Error('cancelled'));
      return { id: 'project' };
    });
    const tool = createAppTools({ request }).find((tool) => tool.name === 'create-lipsync');
    await expect(
      tool?.handler({ videoAssetId: 'video', audioAssetId: 'audio' }, { signal: cancel.signal }),
    ).rejects.toThrow('cancelled');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not undo or retry a generation already accepted upstream', async () => {
    const cancel = new AbortController();
    const request = vi.fn<HttpClient['request']>(async (_method, path) => {
      if (path === '/v2/projects')
        return { items: [{ id: 'project', name: 'ChatGPT generations' }] };
      if (path === '/v2/generate') {
        cancel.abort();
        return { id: 'accepted-generation', status: 'PENDING' };
      }
      throw new Error('unexpected request');
    });
    const tool = createAppTools({ request }).find((tool) => tool.name === 'create-lipsync');
    await expect(
      tool?.handler({ videoAssetId: 'video', audioAssetId: 'audio' }, { signal: cancel.signal }),
    ).resolves.toEqual({ id: 'accepted-generation', status: 'PENDING' });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
