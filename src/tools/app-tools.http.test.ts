import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../http-client.js';
import { UploadRuntime } from '../upload-runtime.js';
import { createAppTools } from './app-tools.js';

async function exerciseStorageUpload(redirectStorage = false) {
  const chunk = Buffer.alloc(64 * 1024, 97);
  const size = chunk.byteLength * 32;
  const tee = vi.spyOn(ReadableStream.prototype, 'tee');
  const observed = {
    uploadedBytes: 0,
    contentLength: '',
    bodyCopies: 0,
    registeredAssets: 0,
    redirectedRequests: 0,
  };
  let copiesBeforeStorage = 0;
  let baseUrl = '';
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/source') {
        response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size });
        await pipeline(
          Readable.from(
            (function* () {
              for (let index = 0; index < 32; index += 1) yield chunk;
            })(),
          ),
          response,
        );
        return;
      }

      if (request.url === '/storage') {
        observed.contentLength = request.headers['content-length'] ?? '';
        for await (const bytes of request) observed.uploadedBytes += bytes.length;
        observed.bodyCopies = tee.mock.calls.length - copiesBeforeStorage;
        if (redirectStorage) {
          response.writeHead(303, { Location: `${baseUrl}/redirected-storage` }).end();
        } else {
          response.writeHead(200).end();
        }
        return;
      }

      if (request.url === '/redirected-storage') {
        observed.redirectedRequests += 1;
        response.writeHead(200).end();
        return;
      }

      // Exercise the real API client as well as the native fetch upload path.
      for await (const _bytes of request) void _bytes;
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v2/assets/upload') {
        copiesBeforeStorage = tee.mock.calls.length;
        response.end(
          JSON.stringify({ uploadUrl: `${baseUrl}/storage`, url: `${baseUrl}/stored.mp4` }),
        );
      } else if (request.url === '/v2/assets') {
        observed.registeredAssets += 1;
        response.end(JSON.stringify({ id: 'durable-asset' }));
      } else {
        response.writeHead(404).end();
      }
    })().catch(() => response.destroy());
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    const runtime = new UploadRuntime({
      maxBytes: size,
      maxConcurrent: 1,
      maxQueued: 0,
      retryAfterMs: 100,
      timeoutMs: 5_000,
    });
    const tool = createAppTools(createHttpClient(baseUrl), runtime).find(
      (candidate) => candidate.name === 'upload-media',
    );
    if (!tool) throw new Error('Missing upload-media tool');
    const result = await tool
      .handler({
        mediaType: 'video',
        file: { download_url: `${baseUrl}/source`, file_id: 'http-test' },
      })
      .then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
    return { ...result, observed, size, stats: runtime.snapshot() };
  } finally {
    tee.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('upload-media with real HTTP streams', () => {
  it('uploads all bytes without retaining a duplicate storage request body', async () => {
    const { value, error, observed, size, stats } = await exerciseStorageUpload();
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ assetId: 'durable-asset' });
    expect(observed.uploadedBytes).toBe(size);
    expect(observed.contentLength).toBe(String(size));
    // A tee creates an unread branch that retains every chunk for redirect replay.
    expect(observed.bodyCopies).toBe(0);
    expect(observed.registeredAssets).toBe(1);
    expect(stats).toMatchObject({ active: 0, completed: 1, uploadedBytes: size });
  });

  it('rejects storage redirects without following them or registering an asset', async () => {
    const { error, observed, stats } = await exerciseStorageUpload(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Could not upload the video to Sync storage');
    expect(observed.redirectedRequests).toBe(0);
    expect(observed.registeredAssets).toBe(0);
    expect(stats).toMatchObject({ active: 0, failed: 1 });
  });
});
