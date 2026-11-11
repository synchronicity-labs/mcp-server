import { describe, expect, it, vi } from 'vitest';
import { resolveClientProfile } from '../client-profile.js';
import type { HttpClient } from '../http-client.js';
import { createAppTools } from './app-tools.js';

// lipsync_create shots: the timeline's camelCase shots in, the API's options.shots out.
function setup() {
  const request = vi.fn(async (_method: string, _path: string, _options?: unknown) => ({
    id: 'gen-1',
    status: 'PENDING',
  }));
  const http: HttpClient = { request };
  const tool = createAppTools(http, undefined, () => resolveClientProfile('claude-code')).find(
    (candidate) => candidate.name === 'lipsync_create',
  )!;
  const create = (extra: Record<string, unknown>) =>
    tool.handler({ projectId: 'project-1', audioAssetId: 'audio-1', ...extra });
  return { create, request };
}

describe('lipsync_create shots', () => {
  it('sends shots as options.shots, next to the other options', async () => {
    const { create, request } = setup();
    await create({
      videoAssetId: 'video-1',
      options: { sync_mode: 'cut_off' },
      shots: [
        { startFrame: 0, endFrame: 48 },
        { startFrame: 48, endFrame: 120 },
      ],
    });
    expect(request).toHaveBeenCalledWith(
      'post',
      '/v2/generate',
      expect.objectContaining({
        body: expect.objectContaining({
          options: {
            sync_mode: 'cut_off',
            shots: [
              { start_frame: 0, end_frame: 48 },
              { start_frame: 48, end_frame: 120 },
            ],
          },
        }),
      }),
    );
  });

  it.each([
    [[{ startFrame: 1, endFrame: 48 }], 'shots[0].startFrame must be 0'],
    [
      [
        { startFrame: 0, endFrame: 48 },
        { startFrame: 50, endFrame: 90 },
      ],
      'shots[1].startFrame must be 48',
    ],
    [
      [
        { startFrame: 0, endFrame: 48 },
        { startFrame: 48, endFrame: 48 },
      ],
      'shots[1].endFrame must be after its startFrame',
    ],
    [[], 'expected array to have >=1 items'],
    [[{ start_frame: 0, end_frame: 48 }], 'Unrecognized key'],
  ])('refuses shots %j before any request', async (shots, message) => {
    const { create, request } = setup();
    await expect(create({ videoAssetId: 'video-1', shots })).rejects.toThrow(message);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses shots for an image', async () => {
    const { create, request } = setup();
    await expect(
      create({ imageAssetId: 'image-1', shots: [{ startFrame: 0, endFrame: 1 }] }),
    ).rejects.toThrow('shots needs a video input');
    expect(request).not.toHaveBeenCalled();
  });

  it('sends no shots and keeps options unchanged without them', async () => {
    const { create, request } = setup();
    await create({ videoAssetId: 'video-1' });
    expect(request.mock.calls[0]?.[2]).not.toHaveProperty('body.options');
  });
});
