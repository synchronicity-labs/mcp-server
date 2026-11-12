import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { createFacePeopleTool, fetchPicture, peopleIn } from './face-people.js';

const ASSET = '0b6c6a1e-3c5e-4a51-9f0e-4b7c2b1d9a10';
const track = (trackId: string, personId: string | null, extra: Record<string, unknown> = {}) => ({
  trackId,
  personId,
  startFrame: 0,
  endFrame: 100,
  detectedFrames: 100,
  faceHeight: { min: 50, median: 100 },
  largestFace: { frame: 10, x: 100, y: 100 },
  pictureUrl: `https://bucket.example.test/${trackId}.jpg`,
  ...extra,
});
const timeline = {
  status: 'completed' as const,
  frameCount: 1000,
  width: 1200,
  tracks: [
    // One person across two shots; the larger face gives the picture and the point.
    track('shot0_a', 'alice', { largestFace: { frame: 5, x: 150, y: 90 } }),
    track('shot1_a', 'alice', {
      startFrame: 500,
      endFrame: 600,
      faceHeight: { min: 100, median: 300 },
      largestFace: { frame: 550, x: 300, y: 200 },
      pictureUrl: 'https://bucket.example.test/alice-close.jpg',
    }),
    track('bob', 'bob', { detectedFrames: 80, largestFace: { frame: 20, x: 1000, y: 100 } }),
    // Unmatched, and too brief to be anyone.
    track('flicker', null, { detectedFrames: 5, pictureUrl: null }),
  ],
  talking: [
    { startFrame: 0, endFrame: 40, speaker: 'SPEAKER_01', trackId: 'shot0_a' },
    { startFrame: 40, endFrame: 60, speaker: null, trackId: null },
    { startFrame: 60, endFrame: 90, speaker: 'SPEAKER_02', trackId: 'bob' },
  ],
};

describe('peopleIn', () => {
  it('groups tracks by person, most visible first, and drops passers-by', () => {
    const { people, omitted } = peopleIn(timeline);
    expect(omitted).toBe(1);
    expect(people).toEqual([
      {
        label: 'person 1',
        personId: 'alice',
        trackIds: ['shot0_a', 'shot1_a'],
        firstFrame: 0,
        lastFrame: 599,
        detectedFrames: 200,
        faceHeight: 300,
        position: 'left',
        select: { frame: 550, x: 300, y: 200 },
        talkingFrames: 40,
        speakers: ['SPEAKER_01'],
        pictureUrl: 'https://bucket.example.test/alice-close.jpg',
      },
      expect.objectContaining({
        label: 'person 2',
        personId: 'bob',
        position: 'right',
        talkingFrames: 30,
        speakers: ['SPEAKER_02'],
      }),
    ]);
  });
});

describe('peopleIn with a split track', () => {
  it('counts each person segment for its own person; picture and point stay with the largest face', () => {
    const split = {
      ...timeline,
      tracks: [
        track('shared', null, {
          startFrame: 0,
          endFrame: 100,
          detectedFrames: 100,
          largestFace: { frame: 80, x: 1000, y: 100 },
          pictureUrl: 'https://bucket.example.test/shared.jpg',
          personSegments: [
            { startFrame: 0, endFrame: 40, personId: 'carol' },
            { startFrame: 40, endFrame: 100, personId: 'dave' },
          ],
        }),
      ],
      talking: [{ startFrame: 20, endFrame: 60, speaker: 'SPEAKER_01', trackId: 'shared' }],
    };
    const { people } = peopleIn(split);
    expect(
      people.map(({ personId, detectedFrames, talkingFrames, select, pictureUrl }) => ({
        personId,
        detectedFrames,
        talkingFrames,
        select,
        pictureUrl,
      })),
    ).toEqual([
      {
        personId: 'dave',
        detectedFrames: 60,
        talkingFrames: 20,
        select: { frame: 80, x: 1000, y: 100 },
        pictureUrl: 'https://bucket.example.test/shared.jpg',
      },
      { personId: 'carol', detectedFrames: 40, talkingFrames: 20, select: null, pictureUrl: null },
    ]);
  });
});

describe('fetchPicture', () => {
  const respond = (bytes: number) =>
    vi.fn(
      async () =>
        new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/jpeg' } }),
    );

  it('reads a picture within the limit and stops reading one past it', async () => {
    vi.stubGlobal('fetch', respond(1024));
    expect(await fetchPicture('https://bucket.example.test/a.jpg')).toMatchObject({
      mimeType: 'image/jpeg',
    });
    vi.stubGlobal('fetch', respond(600 * 1024));
    expect(await fetchPicture('https://bucket.example.test/a.jpg')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('reads only https links', async () => {
    expect(await fetchPicture('http://bucket.example.test/a.jpg')).toBeNull();
  });
});

describe('faces_get-people', () => {
  const http = { request: vi.fn(async () => timeline) };

  it('returns each person with their picture as an image', async () => {
    const readPicture = vi.fn(async (url: string) =>
      url.includes('bob') ? null : { data: 'aGVsbG8=', mimeType: 'image/jpeg' },
    );
    const tool = createFacePeopleTool(http, readPicture);
    const result = (await tool.handler({ assetId: ASSET })) as CallToolResult;
    expect(http.request).toHaveBeenCalledWith(
      'get',
      `/v2/assets/${ASSET}/faces/timeline`,
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({
      assetId: ASSET,
      status: 'completed',
      omitted: 1,
    });
    expect(result.content.slice(1)).toEqual([
      { type: 'text', text: 'person 1 (alice), left' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' },
      { type: 'text', text: 'person 2 (bob), right: no picture' },
    ]);
  });

  it('says so while detection has not finished', async () => {
    const pending = { request: vi.fn(async () => ({ ...timeline, status: 'pending' })) };
    const result = await createFacePeopleTool(pending, vi.fn()).handler({ assetId: ASSET });
    expect(result).toMatchObject({ structuredContent: { status: 'pending', people: [] } });
  });
});
