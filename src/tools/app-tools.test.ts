import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../http-client.js';
import { createAppTools } from './app-tools.js';

describe('createAppTools — create-lipsync', () => {
  // Mock the asset pipeline + generation endpoints. /v2/assets returns a fresh
  // id per call so re-hosted inputs are distinguishable in the generate body.
  function setup() {
    let assetSeq = 0;
    const request = vi.fn(async (_method: string, path: string, _options?: { body?: unknown }) => {
      if (path === '/v2/assets/upload') {
        return { uploadUrl: 'https://s3.example/put', url: 'https://cdn.sync.so/stored.bin' };
      }
      if (path === '/v2/assets') {
        assetSeq += 1;
        return { id: `asset-${assetSeq}` };
      }
      return { id: 'gen-1', status: 'PENDING' };
    });
    const httpClient: HttpClient = { request };
    const tool = createAppTools(httpClient).find((t) => t.name === 'create-lipsync');
    if (!tool) throw new Error('create-lipsync tool not found');
    return { tool, request };
  }

  // Default fetch mock: a GET reads the upload bytes, a PUT stores them.
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { method?: string }) => {
        if (init?.method === 'PUT') {
          return { ok: true, status: 200 };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'video/mp4' },
          arrayBuffer: async () => new ArrayBuffer(8),
        };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lastGenerateBody(request: ReturnType<typeof setup>['request']) {
    const call = request.mock.calls.find((c) => c[1] === '/v2/generate');
    if (!call) throw new Error('POST /v2/generate was never called');
    return (call[2] as { body: { model: string; input: Array<Record<string, unknown>> } }).body;
  }

  it('declares openai/fileParams for video, image + audio and is an open-world write', () => {
    const { tool } = setup();
    expect(tool.meta?.['openai/fileParams']).toEqual(['video', 'image', 'audio']);
    expect(tool.annotations?.openWorldHint).toBe(true);
    expect(tool.annotations?.readOnlyHint).toBe(false);
  });

  it('passes plain URLs straight through without re-hosting', async () => {
    const { tool, request } = setup();
    await tool.handler({ videoUrl: 'https://x/v.mp4', audioUrl: 'https://x/a.wav' });

    expect(fetch).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('post', '/v2/generate', {
      body: {
        model: 'lipsync-2',
        input: [
          { type: 'video', url: 'https://x/v.mp4' },
          { type: 'audio', url: 'https://x/a.wav' },
        ],
      },
    });
  });

  it('chains a tts audioUrl with an uploaded image — re-hosts only the image', async () => {
    const { tool, request } = setup();
    await tool.handler({
      image: { download_url: 'https://files.oai/face.png', mime_type: 'image/png' },
      audioUrl: 'https://assets.sync.so/tts/take.mp3',
    });

    // The uploaded image is re-hosted; the tts URL is used verbatim.
    expect(request).toHaveBeenCalledWith('post', '/v2/assets', {
      body: { url: 'https://cdn.sync.so/stored.bin', type: 'IMAGE' },
    });
    const body = lastGenerateBody(request);
    expect(body.model).toBe('sync-3');
    expect(body.input[0]).toEqual({ type: 'image', assetId: 'asset-1' });
    expect(body.input[1]).toEqual({ type: 'audio', url: 'https://assets.sync.so/tts/take.mp3' });
  });

  it('re-hosts uploaded files through the asset pipeline and passes assetIds', async () => {
    const { tool, request } = setup();
    await tool.handler({
      video: { download_url: 'https://files.oai/clip.mp4' },
      audio: { download_url: 'https://files.oai/voice.wav' },
    });

    // upload-url requested with the byte size, then registered as the right type
    expect(request).toHaveBeenCalledWith('post', '/v2/assets/upload', {
      body: { fileName: 'chatgpt-upload-video', contentType: 'video/mp4', size: 8 },
    });
    expect(request).toHaveBeenCalledWith('post', '/v2/assets', {
      body: { url: 'https://cdn.sync.so/stored.bin', type: 'VIDEO' },
    });
    expect(request).toHaveBeenCalledWith('post', '/v2/assets', {
      body: { url: 'https://cdn.sync.so/stored.bin', type: 'AUDIO' },
    });

    const body = lastGenerateBody(request);
    const [visual, audioItem] = body.input;
    expect(body.model).toBe('lipsync-2');
    expect(visual).toMatchObject({ type: 'video' });
    expect(visual?.assetId).toMatch(/^asset-/);
    expect(visual?.url).toBeUndefined();
    expect(audioItem).toMatchObject({ type: 'audio' });
    expect(audioItem?.assetId).toMatch(/^asset-/);
  });

  it('honours an explicit model', async () => {
    const { tool, request } = setup();
    await tool.handler({
      video: { download_url: 'https://files.oai/clip.mp4' },
      audio: { download_url: 'https://files.oai/voice.wav' },
      model: 'lipsync-2-pro',
    });
    expect(lastGenerateBody(request).model).toBe('lipsync-2-pro');
  });

  it('rejects passing both a video and an image before re-hosting anything', async () => {
    const { tool, request } = setup();
    await expect(
      tool.handler({
        video: { download_url: 'https://x/v.mp4' },
        image: { download_url: 'https://x/face.png' },
        audioUrl: 'https://x/a.wav',
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('throws when no visual is provided', async () => {
    const { tool, request } = setup();
    await expect(tool.handler({ audioUrl: 'https://x/a.wav' })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('throws when audio is missing', async () => {
    const { tool, request } = setup();
    await expect(tool.handler({ video: { download_url: 'https://x/v.mp4' } })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
