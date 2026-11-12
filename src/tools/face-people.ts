import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import { whenEnabled } from './asset-analysis.js';
import type { McpToolDefinition } from './generator.js';

/**
 * The people in a video, each with a picture of their face, so an agent can pick the face
 * to lipsync the way the user describes it: "the redhead", "the kid", "the person on the
 * left". The pictures come from the face timeline (pictureUrl, cropped by the analysis) and
 * are returned as image content the model can look at.
 */

// Enough for a scene with a crowd in the background, few enough to look at.
const MAX_PEOPLE = 8;
// Faces seen for less than half a second at 24 fps are passers-by or detector noise.
const MIN_DETECTED_FRAMES = 12;
const MAX_PICTURE_BYTES = 512 * 1024;
const PICTURE_TIMEOUT_MS = 5_000;

const point = z.object({ frame: z.number().int(), x: z.number().int(), y: z.number().int() });
const timelineSchema = z.object({
  status: z.enum(['completed', 'pending', 'failed', 'not_requested']),
  frameCount: z.number().int().nullable(),
  width: z.number().int().nullable(),
  tracks: z.array(
    z.object({
      trackId: z.string(),
      personId: z.string().nullable(),
      startFrame: z.number().int(),
      endFrame: z.number().int(),
      detectedFrames: z.number().int(),
      faceHeight: z.object({ median: z.number() }).nullable(),
      largestFace: point.nullable().optional(),
      pictureUrl: z.string().nullable().optional(),
    }),
  ),
  talking: z.array(
    z.object({
      startFrame: z.number().int(),
      endFrame: z.number().int(),
      speaker: z.string().nullable(),
      trackId: z.string().nullable(),
    }),
  ),
});
type Timeline = z.infer<typeof timelineSchema>;

type Person = {
  label: string;
  personId: string;
  trackIds: string[];
  firstFrame: number;
  lastFrame: number;
  detectedFrames: number;
  faceHeight: number | null;
  position: 'left' | 'center' | 'right' | null;
  select: z.infer<typeof point> | null;
  talkingFrames: number;
  speakers: string[];
  pictureUrl: string | null;
};

/** One entry per person (tracks matched across shots), most visible first. */
export function peopleIn(timeline: Timeline): { people: Person[]; omitted: number } {
  const talking = new Map<string, { frames: number; speakers: Set<string> }>();
  for (const span of timeline.talking) {
    if (!span.trackId) continue;
    const entry = talking.get(span.trackId) ?? { frames: 0, speakers: new Set<string>() };
    entry.frames += span.endFrame - span.startFrame;
    if (span.speaker) entry.speakers.add(span.speaker);
    talking.set(span.trackId, entry);
  }
  const groups = new Map<string, Timeline['tracks']>();
  for (const track of timeline.tracks) {
    const id = track.personId ?? track.trackId;
    groups.set(id, [...(groups.get(id) ?? []), track]);
  }
  const all = [...groups].map(([personId, tracks]) => {
    // The track where the face is biggest gives the picture and the point.
    const best = tracks.reduce((a, b) =>
      (b.faceHeight?.median ?? 0) > (a.faceHeight?.median ?? 0) ? b : a,
    );
    const select = best.largestFace ?? null;
    const third = timeline.width && select ? select.x / timeline.width : null;
    const talks = tracks.map((track) => talking.get(track.trackId));
    return {
      personId,
      trackIds: tracks.map((track) => track.trackId),
      firstFrame: Math.min(...tracks.map((track) => track.startFrame)),
      lastFrame: Math.max(...tracks.map((track) => track.endFrame)) - 1,
      detectedFrames: tracks.reduce((sum, track) => sum + track.detectedFrames, 0),
      faceHeight: best.faceHeight ? Math.round(best.faceHeight.median) : null,
      position: third === null ? null : third < 1 / 3 ? 'left' : third > 2 / 3 ? 'right' : 'center',
      select,
      talkingFrames: talks.reduce((sum, talk) => sum + (talk?.frames ?? 0), 0),
      speakers: [...new Set(talks.flatMap((talk) => [...(talk?.speakers ?? [])]))].sort(),
      pictureUrl: best.pictureUrl ?? tracks.find((track) => track.pictureUrl)?.pictureUrl ?? null,
    } satisfies Omit<Person, 'label'>;
  });
  const seen = all
    .filter((person) => person.detectedFrames >= MIN_DETECTED_FRAMES)
    .sort((a, b) => b.detectedFrames - a.detectedFrames || a.firstFrame - b.firstFrame);
  const people = seen
    .slice(0, MAX_PEOPLE)
    .map((person, index) => ({ label: `person ${index + 1}`, ...person }));
  return { people, omitted: all.length - people.length };
}

export type FetchPicture = (
  url: string,
  signal?: AbortSignal,
) => Promise<{ data: string; mimeType: string } | null>;

/** A picture as base64, or null when it cannot be read; the people list stands without it. */
export const fetchPicture: FetchPicture = async (url, signal) => {
  if (!url.startsWith('https://')) return null;
  try {
    const timeout = AbortSignal.timeout(PICTURE_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error',
    });
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!response.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PICTURE_BYTES) return null;
    return { data: bytes.toString('base64'), mimeType };
  } catch {
    signal?.throwIfAborted();
    return null;
  }
};

const assetId = z.uuid().describe('The VIDEO asset, after faces_detect completed.');

export function createFacePeopleTool(
  http: HttpClient,
  readPicture: FetchPicture = fetchPicture,
): McpToolDefinition {
  const input = z.object({ assetId });
  return {
    name: 'faces_get-people',
    title: 'See the people in a video',
    description:
      'Show the people faces_detect found in a saved VIDEO asset, each with a picture of their face, to pick the face to lipsync the way the user describes it: by look ("the redhead", "the kid", "the man in glasses"), by place ("the person on the left") or by voice ("whoever speaks first"). Up to 8 people, most visible first, labeled person 1, person 2 and so on. ' +
      'Each has the picture (as an image, and pictureUrl, a link valid for an hour), position in the frame where their face is largest, faceHeight in pixels, the frames they appear in, how many frames they talk and their speaker labels, and select: a point on their face. ' +
      'To lipsync that person, pass select as options.active_speaker_detection { frame_number: select.frame, coordinates: [select.x, select.y] } on lipsync_create. Never pass boxes. select is where the face is largest, which can fall outside the part that gets lipsynced (a short driver lipsyncs only the opening frames; a timeline clip only its range). Then take a point on that person inside that part instead: a faces_get-timeline talking point of one of their trackIds, or their box center from faces_get. ' +
      'Compare the pictures with the description yourself. If several people could match, or none clearly does, show the user the pictures with their labels and ask which one before creating. ' +
      'status is pending until faces_detect finishes; call faces_detect with wait: true first.',
    inputSchema: input.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    resultFormat: 'mcp',
    handler: (args, context) =>
      whenEnabled('Face timeline', async (): Promise<CallToolResult> => {
        const { assetId: id } = input.parse(args);
        const timeline = timelineSchema.parse(
          await http.request('get', `/v2/assets/${id}/faces/timeline`, {
            signal: context?.signal,
          }),
        );
        if (timeline.status !== 'completed') {
          const structuredContent = { assetId: id, status: timeline.status, people: [] };
          return {
            content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
            structuredContent,
          };
        }
        const { people, omitted } = peopleIn(timeline);
        const pictures = await Promise.all(
          people.map(async (person) =>
            person.pictureUrl ? readPicture(person.pictureUrl, context?.signal) : null,
          ),
        );
        const structuredContent = {
          assetId: id,
          status: timeline.status,
          people,
          omitted,
        };
        return {
          content: [
            { type: 'text', text: JSON.stringify(structuredContent) },
            ...people.flatMap((person, index) => {
              const picture = pictures[index];
              const caption = `${person.label} (${person.personId})${person.position ? `, ${person.position}` : ''}`;
              return picture
                ? [
                    { type: 'text' as const, text: caption },
                    { type: 'image' as const, data: picture.data, mimeType: picture.mimeType },
                  ]
                : [{ type: 'text' as const, text: `${caption}: no picture` }];
            }),
          ],
          structuredContent,
        };
      }),
  };
}
