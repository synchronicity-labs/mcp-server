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

  it('declares openai/fileParams for video + audio and is an open-world write', () => {
    const { tool } = setup();
    expect(tool.meta?.['openai/fileParams']).toEqual(['video', 'audio']);
    expect(tool.annotations?.openWorldHint).toBe(true);
    expect(tool.annotations?.readOnlyHint).toBe(false);
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
