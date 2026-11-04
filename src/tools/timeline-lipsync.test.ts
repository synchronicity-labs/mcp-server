import { describe, expect, it, vi } from 'vitest';
import { resolveClientProfile } from '../client-profile.js';
import type { HttpClient } from '../http-client.js';
import { selectHostedHttpTools } from '../server.js';
import { createTimelineLipsyncTool } from './timeline-lipsync.js';

const VIDEO = '0be08891-00e2-4811-84d7-5c38f6bb602a';
const A = '51ef4ef2-84af-4622-b0d0-c47ac04785da';
const B = '7d3f0c55-3c1e-4a5e-9a0e-2f4c1b6d8e90';
const PROJECT = '3c1f0f4e-1b2d-4c5e-8f6a-7b8c9d0e1f2a';

function setup() {
  const request = vi.fn(async () => ({ id: 'generation-1', status: 'PENDING' }));
  const tool = createTimelineLipsyncTool({ request } as unknown as HttpClient);
  return { request, tool };
}

describe('create-timeline-lipsync', () => {
  it('sends each audio once and each clip as a segment over its part of that audio', async () => {
    const { request, tool } = setup();

    await tool.handler({
      videoAssetId: VIDEO,
      projectId: PROJECT,
      model: 'lipsync-2',
      idempotencyKey: 'timeline-1',
      clips: [
        { audioAssetId: B, startTime: 6, endTime: 10, audioEndTime: 4, syncMode: 'cut_off' },
        { audioAssetId: A, startTime: 0, endTime: 2, audioStartTime: 0, audioEndTime: 2 },
        { audioAssetId: A, startTime: 3, endTime: 4, audioStartTime: 3, audioEndTime: 4 },
      ],
    });

    expect(request).toHaveBeenCalledWith('post', '/v2/generate', {
      signal: undefined,
      headers: { 'Idempotency-Key': 'timeline-1' },
      body: {
        model: 'lipsync-2',
        input: [
          { type: 'video', assetId: VIDEO },
          { type: 'audio', assetId: B, refId: 'audio-1' },
          { type: 'audio', assetId: A, refId: 'audio-2' },
        ],
        segments: [
          {
            startTime: 6,
            endTime: 10,
            audioInput: { refId: 'audio-1', endTime: 4 },
            optionsOverride: { sync_mode: 'cut_off' },
          },
          {
            startTime: 0,
            endTime: 2,
            audioInput: { refId: 'audio-2', startTime: 0, endTime: 2 },
          },
          {
            startTime: 3,
            endTime: 4,
            audioInput: { refId: 'audio-2', startTime: 3, endTime: 4 },
          },
        ],
        projectId: PROJECT,
      },
    });
  });

  it.each([
    [
      'overlapping clips',
      [
        { audioAssetId: A, startTime: 0, endTime: 3 },
        { audioAssetId: B, startTime: 2, endTime: 5 },
      ],
      'clips[0] (seconds 0-3) and clips[1] (seconds 2-5) overlap',
    ],
    [
      'a clip that ends before it starts',
      [{ audioAssetId: A, startTime: 4, endTime: 4 }],
      'end after it starts',
    ],
    [
      'an audio range that ends at its default start',
      [{ audioAssetId: A, startTime: 0, endTime: 2, audioEndTime: 0 }],
      'audioEndTime',
    ],
    [
      'a clip given both seconds and frames',
      [{ audioAssetId: A, startTime: 0, endTime: 2, startFrame: 0, endFrame: 48 }],
      'startTime and endTime, or startFrame and endFrame',
    ],
    [
      'a clip with only a start frame',
      [{ audioAssetId: A, startFrame: 10 }],
      'startTime and endTime, or startFrame and endFrame',
    ],
    [
      'clips sharing a frame',
      [
        { audioAssetId: A, startFrame: 0, endFrame: 48 },
        { audioAssetId: B, startFrame: 48, endFrame: 96 },
      ],
      'clips[0] (frames 0-48) and clips[1] (frames 48-96) overlap',
    ],
    [
      'a picked frame outside its clip',
      [
        {
          audioAssetId: A,
          startFrame: 0,
          endFrame: 48,
          speaker: { frameNumber: 49, x: 1, y: 1 },
        },
      ],
      'clips[0]: speaker.frameNumber 49 is not one of its 49 frames',
    ],
    [
      'a clip naming no audio',
      [{ startTime: 0, endTime: 2 }],
      'clips[0]: give audioAssetId or audioUrl',
    ],
    [
      'a clip naming both an asset and a URL',
      [
        {
          audioAssetId: A,
          audioUrl: 'https://cdn.example.test/dub.flac',
          startTime: 0,
          endTime: 2,
        },
      ],
      'exactly one',
    ],
    [
      'an empty audio range',
      [{ audioAssetId: A, startTime: 0, endTime: 2, audioStartTime: 2, audioEndTime: 1 }],
      'audioEndTime',
    ],
  ])('refuses %s before calling the API', async (_case, clips, message) => {
    const { request, tool } = setup();

    await expect(tool.handler({ videoAssetId: VIDEO, projectId: PROJECT, clips })).rejects.toThrow(
      message,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('sends an audio URL as its own input, shared by the clips that play it', async () => {
    const { request, tool } = setup();
    const dub = 'https://cdn.example.test/dubbing-1.flac';

    await tool.handler({
      videoAssetId: VIDEO,
      projectId: PROJECT,
      clips: [
        { audioUrl: dub, startTime: 0, endTime: 2, audioStartTime: 0, audioEndTime: 2 },
        { audioAssetId: A, startTime: 3, endTime: 4 },
        { audioUrl: dub, startTime: 5, endTime: 6, audioStartTime: 5, audioEndTime: 6 },
      ],
    });

    expect(request).toHaveBeenCalledWith(
      'post',
      '/v2/generate',
      expect.objectContaining({
        body: expect.objectContaining({
          input: [
            { type: 'video', assetId: VIDEO },
            { type: 'audio', url: dub, refId: 'audio-1' },
            { type: 'audio', assetId: A, refId: 'audio-2' },
          ],
        }),
      }),
    );
  });

  it('refuses more clips than the API takes, before calling it', async () => {
    const request = vi.fn();
    const tool = createTimelineLipsyncTool({ request } as unknown as HttpClient, undefined, 2);
    const clips = [0, 1, 2].map((i) => ({ audioAssetId: A, startTime: i, endTime: i + 0.5 }));

    await expect(tool.handler({ videoAssetId: VIDEO, projectId: PROJECT, clips })).rejects.toThrow(
      'at most 2 clips; this request has 3',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('passes a face picked in a frame, a face track or detection as the clip’s speaker', async () => {
    const { request, tool } = setup();
    const track = 'https://cdn.example.test/asd-boxes/seg1.json';

    await tool.handler({
      videoAssetId: VIDEO,
      projectId: PROJECT,
      clips: [
        {
          audioAssetId: A,
          startFrame: 0,
          endFrame: 119,
          speaker: { frameNumber: 12, x: 640, y: 360 },
        },
        {
          audioAssetId: B,
          startTime: 6,
          endTime: 10,
          syncMode: 'bounce',
          speaker: { faceTrackUrl: track },
        },
        { audioAssetId: A, startTime: 11, endTime: 11.5, speaker: { detect: true } },
      ],
    });

    expect(request).toHaveBeenCalledWith(
      'post',
      '/v2/generate',
      expect.objectContaining({
        body: expect.objectContaining({
          segments: [
            {
              startFrame: 0,
              endFrame: 119,
              audioInput: { refId: 'audio-1' },
              optionsOverride: {
                active_speaker_detection: {
                  auto_detect: false,
                  frame_number: 12,
                  coordinates: [640, 360],
                },
              },
            },
            {
              startTime: 6,
              endTime: 10,
              audioInput: { refId: 'audio-2' },
              optionsOverride: {
                sync_mode: 'bounce',
                active_speaker_detection: { auto_detect: false, bounding_boxes_url: track },
              },
            },
            {
              startTime: 11,
              endTime: 11.5,
              audioInput: { refId: 'audio-1' },
              optionsOverride: { active_speaker_detection: { auto_detect: true } },
            },
          ],
        }),
      }),
    );
  });

  it.each([true, false])(
    'sends speaker detection %s as the object the API takes, like create-lipsync',
    async (detect) => {
      const { request, tool } = setup();

      await tool.handler({
        videoAssetId: VIDEO,
        projectId: PROJECT,
        options: { active_speaker_detection: detect, sync_mode: 'bounce' },
        clips: [{ audioAssetId: A, startTime: 0, endTime: 2 }],
      });

      expect(request).toHaveBeenCalledWith(
        'post',
        '/v2/generate',
        expect.objectContaining({
          body: expect.objectContaining({
            options: { active_speaker_detection: { auto_detect: detect }, sync_mode: 'bounce' },
          }),
        }),
      );
    },
  );

  it('is offered to agents but kept out of the ChatGPT app listing', () => {
    const { tool } = setup();
    const names = (client: string) =>
      selectHostedHttpTools([tool], resolveClientProfile(client)).map((t) => t.name);

    for (const client of ['claude-ai', 'claude-code', 'openai-mcp (Codex)', 'cursor'])
      expect(names(client)).toEqual(['create-timeline-lipsync']);
    expect(names('openai-mcp')).toEqual([]);
  });
});
