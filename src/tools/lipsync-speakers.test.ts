import { describe, expect, it, vi } from 'vitest';
import { resolveClientProfile } from '../client-profile.js';
import type { HttpClient } from '../http-client.js';
import { createAppTools } from './app-tools.js';

// lipsync_create speakers: one audio input per speaker and the API's speakers out.
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
    tool.handler({ projectId: 'project-1', videoAssetId: 'video-1', ...extra });
  return { create, request };
}

const point = { frameNumber: 2, coordinates: [339, 633] };

describe('lipsync_create speakers', () => {
  it('sends each speaker’s audio as its own input, boxes with gaps, and the overlap option', async () => {
    const { create, request } = setup();
    const boxes = [[10, 20, 110, 140], null, [12, 22, 112, 142]];
    await create({
      options: { temperature: 0.5 },
      allowOverlappingFaces: true,
      speakers: [
        { id: 'left', audioAssetId: 'audio-left', face: point },
        { id: 'right', audioUrl: 'https://media.example.test/right.wav', face: { boxes } },
        {
          id: 'back',
          audioAssetId: 'audio-back',
          face: { faceTrackUrl: 'https://media.example.test/back.json' },
        },
      ],
    });
    expect(request).toHaveBeenCalledWith(
      'post',
      '/v2/generate',
      expect.objectContaining({
        body: {
          model: 'sync-3',
          options: { temperature: 0.5, allow_overlapping_boxes: true },
          input: [
            { type: 'video', assetId: 'video-1' },
            { type: 'audio', refId: 'left', assetId: 'audio-left' },
            { type: 'audio', refId: 'right', url: 'https://media.example.test/right.wav' },
            { type: 'audio', refId: 'back', assetId: 'audio-back' },
          ],
          speakers: [
            {
              id: 'left',
              audio: { refId: 'left' },
              face: { frame_number: 2, coordinates: [339, 633] },
            },
            { id: 'right', audio: { refId: 'right' }, face: { bounding_boxes: boxes } },
            {
              id: 'back',
              audio: { refId: 'back' },
              face: { bounding_boxes_url: 'https://media.example.test/back.json' },
            },
          ],
          projectId: 'project-1',
        },
      }),
    );
  });

  it.each([
    [
      'a single audio next to speakers',
      { audioAssetId: 'audio-1', speakers: [{ id: 'left', audioAssetId: 'a', face: point }] },
      'give each speaker its own audio',
    ],
    [
      'an image',
      {
        videoAssetId: undefined,
        imageAssetId: 'image-1',
        speakers: [{ id: 'left', audioAssetId: 'a', face: point }],
      },
      'speakers needs a video input',
    ],
    [
      'two speakers with one id',
      {
        speakers: [
          { id: 'left', audioAssetId: 'a', face: point },
          { id: 'left', audioAssetId: 'b', face: point },
        ],
      },
      'speakers[1].id "left" is used twice',
    ],
    [
      'a speaker without audio',
      { speakers: [{ id: 'left', face: point }] },
      'speakers[0] needs exactly one of audioUrl or audioAssetId',
    ],
    [
      'a face given two ways',
      { speakers: [{ id: 'left', audioAssetId: 'a', face: { ...point, boxes: [null] } }] },
      'speakers[0].face needs exactly one of',
    ],
    [
      'a point without coordinates',
      { speakers: [{ id: 'left', audioAssetId: 'a', face: { frameNumber: 2 } }] },
      'speakers[0].face needs both frameNumber and coordinates',
    ],
    [
      'the overlap option alone',
      { audioAssetId: 'audio-1', allowOverlappingFaces: true },
      'needs speakers',
    ],
  ])('refuses %s before any request', async (_case, extra, message) => {
    const { create, request } = setup();
    await expect(create(extra)).rejects.toThrow(message);
    expect(request).not.toHaveBeenCalled();
  });
});
