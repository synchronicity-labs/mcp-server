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
      'Clips overlap',
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
