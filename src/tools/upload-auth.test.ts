import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithAuth } from '../auth/async-context.js';
import { createHttpClient } from '../http-client.js';
import { UploadRuntime } from '../upload-runtime.js';
import { createAppTools } from './app-tools.js';

afterEach(() => vi.unstubAllGlobals());

describe('ChatGPT upload OAuth compatibility', () => {
  it.each([
    'openai-mcp',
    'OpenAI-MCP',
  ])('preserves the API-compatible source and OAuth token through an upload from %s', async (clientName) => {
    const apiHeaders: Headers[] = [];
    let uploadedBytes = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (url === 'https://files.example/video.mp4') {
        expect(headers.has('authorization')).toBe(false);
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'video/mp4', 'content-length': '3' },
        });
      }
      if (url === 'https://storage.example/upload') {
        expect(headers.has('authorization')).toBe(false);
        expect(init?.method).toBe('PUT');
        if (!(init?.body instanceof Readable)) throw new Error('Expected streamed upload');
        for await (const chunk of init.body) uploadedBytes += chunk.byteLength;
        return new Response(null, { status: 200 });
      }
      apiHeaders.push(headers);
      // The deployed API selects OAuth bearer authentication for mcp/mcp:* sources.
      const source = headers.get('x-sync-source');
      if (source !== 'mcp' && !source?.startsWith('mcp:')) {
        return Response.json(
          { message: 'Either Cookie or x-api-key header must be provided' },
          { status: 401, statusText: 'Unauthorized' },
        );
      }
      expect(headers.get('authorization')).toBe('Bearer oauth-upload-test');
      if (url === 'https://api.example/v2/assets/upload') {
        return Response.json({
          uploadUrl: 'https://storage.example/upload',
          url: 'https://storage.example/video.mp4',
        });
      }
      if (url === 'https://api.example/v2/assets') {
        expect(uploadedBytes).toBe(3);
        return Response.json({ id: 'uploaded-asset' });
      }
      throw new Error(`Unexpected endpoint: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new UploadRuntime();
    const upload = createAppTools(createHttpClient('https://api.example'), runtime).find(
      (tool) => tool.name === 'upload-media',
    );
    if (!upload) throw new Error('Missing upload tool');
    const result = await runWithAuth('oauth-upload-test', clientName, () =>
      upload.handler({
        mediaType: 'video',
        file: {
          file_id: 'file-test',
          download_url: 'https://files.example/video.mp4',
          file_name: 'video.mp4',
          mime_type: 'video/mp4',
        },
      }),
    );
    expect(result).toMatchObject({ assetId: 'uploaded-asset', mediaType: 'video' });
    expect(apiHeaders).toHaveLength(2);
    expect(apiHeaders.map((headers) => headers.get('x-sync-source'))).toEqual([
      `mcp:${clientName}`,
      `mcp:${clientName}`,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(runtime.snapshot()).toMatchObject({ completed: 1, failed: 0, uploadedBytes: 3 });
  });
});
