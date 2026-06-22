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
    const tools = createAppTools(httpClient);
    const uploadTool = tools.find((t) => t.name === 'upload-media');
    const tool = tools.find((t) => t.name === 'create-lipsync');
    if (!uploadTool) throw new Error('upload-media tool not found');
    if (!tool) throw new Error('create-lipsync tool not found');
    return { tool, uploadTool, request };
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

  function chatGptFile(
    downloadUrl: string,
    extra: { mime_type?: string; file_name?: string } = {},
  ) {
    return {
      download_url: downloadUrl,
      file_id: `file-${downloadUrl.split('/').pop() ?? 'upload'}`,
      ...extra,
    };
  }

  it('declares openai/fileParams for video, image + audio and is an open-world write', () => {
    const { tool } = setup();
    expect(tool.title).toBe('Create lipsync');
    expect(tool.description).toContain('prefer calling upload-media first');
    expect(tool.description).toContain('direct `audio`/`video`/`image` file params are supported');
    expect(tool.meta?.['openai/fileParams']).toEqual(['video', 'image', 'audio']);
    expect(tool.outputSchema).toMatchObject({
      id: expect.any(Object),
      status: expect.any(Object),
      model: expect.any(Object),
      outputUrl: expect.any(Object),
    });
    expect(tool.annotations?.openWorldHint).toBe(true);
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.annotations?.destructiveHint).toBe(false);
  });

  it('declares upload-media as a file-param asset staging tool', () => {
    const { uploadTool } = setup();
    expect(uploadTool.title).toBe('Upload media');
    expect(uploadTool.meta?.['openai/fileParams']).toEqual(['file']);
    expect(uploadTool.meta?.['openai/widgetAccessible']).toBe(true);
    expect(uploadTool.outputSchema).toMatchObject({
      assetId: expect.any(Object),
      mediaType: expect.any(Object),
      assetType: expect.any(Object),
      input: expect.any(Object),
    });
    expect(uploadTool.annotations?.openWorldHint).toBe(true);
    expect(uploadTool.annotations?.readOnlyHint).toBe(false);
    expect(uploadTool.annotations?.destructiveHint).toBe(false);
  });

  it('uploads a ChatGPT file to a durable Sync asset', async () => {
    const { uploadTool, request } = setup();
    const result = await uploadTool.handler({
      mediaType: 'image',
      file: chatGptFile('https://files.oai/face.png', {
        file_name: 'face.png',
        mime_type: 'image/png',
      }),
    });

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://files.oai/face.png');
    expect(request).toHaveBeenCalledWith('post', '/v2/assets', {
      body: { url: 'https://cdn.sync.so/stored.bin', type: 'IMAGE' },
    });
    expect(result).toEqual({
      assetId: 'asset-1',
      mediaType: 'image',
      assetType: 'IMAGE',
      input: { type: 'image', assetId: 'asset-1' },
    });
  });

  it('rejects a URL string passed to upload-media file with a clear message', async () => {
    const { uploadTool, request } = setup();

    await expect(
      uploadTool.handler({
        mediaType: 'image',
        file: 'https://cdn.example/face.png',
      }),
    ).rejects.toThrow(/file slot[\s\S]*assets_create/);
    expect(fetch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
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
      image: chatGptFile('https://files.oai/face.png', { mime_type: 'image/png' }),
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

  it('creates image-to-video lipsync directly from script text', async () => {
    const { tool, request } = setup();
    await tool.handler({
      imageUrl: 'https://x/face.png',
      script: 'hello from the direct text path',
      voiceId: 'voice-1',
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('post', '/v2/generate', {
      body: {
        model: 'sync-3',
        input: [
          { type: 'image', url: 'https://x/face.png' },
          {
            type: 'text',
            provider: {
              name: 'elevenlabs',
              voiceId: 'voice-1',
              script: 'hello from the direct text path',
            },
          },
        ],
      },
    });
  });

  it('creates image-to-video lipsync from a pre-uploaded image asset id', async () => {
    const { tool, request } = setup();
    await tool.handler({
      imageAssetId: 'asset-face',
      script: 'hello from the asset path',
      voiceId: 'voice-1',
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('post', '/v2/generate', {
      body: {
        model: 'sync-3',
        input: [
          { type: 'image', assetId: 'asset-face' },
          {
            type: 'text',
            provider: {
              name: 'elevenlabs',
              voiceId: 'voice-1',
              script: 'hello from the asset path',
            },
          },
        ],
      },
    });
  });

  it('passes optional text voice controls through to generation', async () => {
    const { tool, request } = setup();
    await tool.handler({
      videoUrl: 'https://x/clip.mp4',
      script: 'controlled voice',
      voiceId: 'voice-2',
      provider: 'elevenlabs',
      stability: 0.4,
      similarityBoost: 0.8,
    });

    const body = lastGenerateBody(request);
    expect(body.model).toBe('lipsync-2');
    expect(body.input[1]).toEqual({
      type: 'text',
      provider: {
        name: 'elevenlabs',
        voiceId: 'voice-2',
        script: 'controlled voice',
        stability: 0.4,
        similarityBoost: 0.8,
      },
    });
  });

  it('re-hosts uploaded files through the asset pipeline and passes assetIds', async () => {
    const { tool, request } = setup();
    await tool.handler({
      video: chatGptFile('https://files.oai/clip.mp4'),
      audio: chatGptFile('https://files.oai/voice.wav'),
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
      video: chatGptFile('https://files.oai/clip.mp4'),
      audio: chatGptFile('https://files.oai/voice.wav'),
      model: 'lipsync-2-pro',
    });
    expect(lastGenerateBody(request).model).toBe('lipsync-2-pro');
  });

  it('rejects passing both a video and an image before re-hosting anything', async () => {
    const { tool, request } = setup();
    await expect(
      tool.handler({
        video: chatGptFile('https://x/v.mp4'),
        image: chatGptFile('https://x/face.png'),
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
    await expect(tool.handler({ video: chatGptFile('https://x/v.mp4') })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('throws when both audio and script are provided', async () => {
    const { tool, request } = setup();
    await expect(
      tool.handler({
        videoUrl: 'https://x/v.mp4',
        audioUrl: 'https://x/a.wav',
        script: 'too many drivers',
        voiceId: 'voice-1',
      }),
    ).rejects.toThrow(/either audio or script/);
    expect(request).not.toHaveBeenCalled();
  });

  it('throws when script is provided without a voiceId', async () => {
    const { tool, request } = setup();
    await expect(
      tool.handler({
        imageUrl: 'https://x/face.png',
        script: 'missing voice',
      }),
    ).rejects.toThrow(/voiceId is required/);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) upload reference and echoes the value', async () => {
    const { tool, request } = setup();
    await expect(
      tool.handler({
        image: chatGptFile('sandbox:/mnt/data/face.png'),
        audioUrl: 'https://x/a.wav',
      }),
    ).rejects.toThrow(/sandbox:\/mnt\/data\/face\.png[\s\S]*imageUrl/);
    expect(fetch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a bare local path string (ChatGPT dev-mode upload) with a clear message', async () => {
    const { tool, request } = setup();
    await expect(
      tool.handler({
        image: '/mnt/data/mhadi(1).jpeg',
        audioUrl: 'https://assets.sync.so/tts/take.mp3',
      }),
    ).rejects.toThrow(/\/mnt\/data\/mhadi\(1\)\.jpeg[\s\S]*imageUrl/);
    expect(fetch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects an http(s) string in a file slot with a clear message', async () => {
    const { tool, request } = setup();
    await expect(
      tool.handler({ video: 'https://x/v.mp4', audioUrl: 'https://x/a.wav' }),
    ).rejects.toThrow(/file slot[\s\S]*videoUrl/);
    expect(fetch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("surfaces the host + underlying cause when the upload URL can't be reached", async () => {
    const { tool } = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', {
          cause: new Error('getaddrinfo ENOTFOUND files.oai'),
        });
      }),
    );
    await expect(
      tool.handler({
        image: chatGptFile('https://files.oai/face.png'),
        audioUrl: 'https://x/a.wav',
      }),
    ).rejects.toThrow(/files\.oai[\s\S]*ENOTFOUND/);
  });
});
