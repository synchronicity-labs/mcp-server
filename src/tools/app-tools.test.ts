import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../http-client.js';
import { createAppTools } from './app-tools.js';

describe('createAppTools — create-lipsync', () => {
  function setup() {
    const request = vi.fn().mockResolvedValue({ id: 'gen-1', status: 'PENDING' });
    const httpClient: HttpClient = { request };
    const tool = createAppTools(httpClient).find((t) => t.name === 'create-lipsync');
    if (!tool) throw new Error('create-lipsync tool not found');
    return { tool, request };
  }

  it('declares openai/fileParams for video, image + audio and is an open-world write', () => {
    const { tool } = setup();
    expect(tool.meta?.['openai/fileParams']).toEqual(['video', 'image', 'audio']);
    expect(tool.annotations?.openWorldHint).toBe(true);
    expect(tool.annotations?.readOnlyHint).toBe(false);
  });

  it('maps an image input to a sync-3 image-to-video generation', async () => {
    const { tool, request } = setup();
    await tool.handler({
      image: { download_url: 'https://x/face.png' },
      audio: { download_url: 'https://x/a.wav' },
    });
    expect(request).toHaveBeenCalledWith('post', '/v2/generate', {
      body: {
        model: 'sync-3',
        input: [
          { type: 'image', url: 'https://x/face.png' },
          { type: 'audio', url: 'https://x/a.wav' },
        ],
      },
    });
  });

  it('chains a tts audioUrl with an uploaded image (the lipsync-an-image-to-speech flow)', async () => {
    const { tool, request } = setup();
    await tool.handler({
      image: { download_url: 'https://x/face.png' },
      audioUrl: 'https://assets.sync.so/tts/take.mp3',
    });
    expect(request).toHaveBeenCalledWith('post', '/v2/generate', {
      body: {
        model: 'sync-3',
        input: [
          { type: 'image', url: 'https://x/face.png' },
          { type: 'audio', url: 'https://assets.sync.so/tts/take.mp3' },
        ],
      },
    });
  });

  it('accepts plain URLs for every input', async () => {
    const { tool, request } = setup();
    await tool.handler({
      videoUrl: 'https://x/v.mp4',
      audioUrl: 'https://x/a.wav',
    });
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

  it('rejects passing both a video and an image', async () => {
    const { tool, request } = setup();
    await expect(
      tool.handler({
        video: { download_url: 'https://x/v.mp4' },
        image: { download_url: 'https://x/face.png' },
        audio: { download_url: 'https://x/a.wav' },
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('maps file download URLs into a POST /v2/generate body', async () => {
    const { tool, request } = setup();
    await tool.handler({
      video: { download_url: 'https://x/v.mp4' },
      audio: { download_url: 'https://x/a.wav' },
    });
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

  it('honours an explicit model', async () => {
    const { tool, request } = setup();
    await tool.handler({
      video: { download_url: 'https://x/v.mp4' },
      audio: { download_url: 'https://x/a.wav' },
      model: 'lipsync-2-pro',
    });
    expect(request).toHaveBeenCalledWith(
      'post',
      '/v2/generate',
      expect.objectContaining({ body: expect.objectContaining({ model: 'lipsync-2-pro' }) }),
    );
  });

  it('throws when a file is missing its download_url', async () => {
    const { tool, request } = setup();
    await expect(
      tool.handler({ video: {}, audio: { download_url: 'https://x/a.wav' } }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
