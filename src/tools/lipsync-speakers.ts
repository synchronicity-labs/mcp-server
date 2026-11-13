import { z } from 'zod';

/**
 * lipsync_create `speakers`: several people in one video, each lipsynced to their own audio
 * in ONE generation (sync-3 and sync-3-pro), sent as `speakers` on POST /v2/generate with
 * one audio input per speaker. Listed only to accounts with the multispeaker feature
 * (PARAMETER_FEATURES in account-features.ts); the API refuses it for others.
 */
const box = z
  .tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()])
  .nullable();

const speakerFace = z
  .object({
    frameNumber: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Frame showing this person’s face, counted from 0 at the video’s first frame. With coordinates.',
      ),
    coordinates: z
      .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
      .optional()
      .describe('[x, y] pixel on the face centre in frameNumber, in the upright video frame.'),
    boxes: z
      .array(box)
      .min(1)
      .optional()
      .describe(
        'One entry per video frame: [x1, y1, x2, y2] whole pixels around the face, or null to leave this face as it is in the source on that frame.',
      ),
    faceTrackUrl: z
      .string()
      .url()
      .optional()
      .describe(
        'URL of a public JSON file { "bounding_boxes": [...] } with the same per-frame entries as boxes.',
      ),
  })
  .strict()
  .describe(
    'How to find this person: frameNumber with coordinates (a point on the face), boxes, or faceTrackUrl. Exactly one. A point lipsyncs that face for the WHOLE video, also where the person only listens, which replaces their reactions (a laugh becomes a closed mouth). Boxes with null on the shots where the person has no lines keep those shots as filmed, so prefer boxes when a person is on screen without speaking.',
  );

const speaker = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .describe('Your name for this speaker: letters, digits, _ or -. Not "default".'),
    audioUrl: z.string().optional().describe('Public or Sync-hosted URL of this speaker’s audio.'),
    audioAssetId: z.string().optional().describe('Sync asset id of this speaker’s audio.'),
    face: speakerFace,
  })
  .strict();

export const lipsyncSpeakersInput = z
  .array(speaker)
  .min(1)
  .optional()
  .describe(
    'Several people in one video, each lipsynced to their own audio in ONE generation, instead of audio/script. sync-3 or sync-3-pro with a video only. Give each speaker an audio track as long as the video (within 0.04 s) holding only that person’s words and quiet where the others talk; the output plays the tracks mixed together. At most 3 speakers unless the organization has a higher limit. Cannot be combined with audioUrl, audioAssetId, audio, script or options.active_speaker_detection.',
  );

export const allowOverlappingFacesInput = z
  .boolean()
  .optional()
  .describe(
    'With speakers: set true when two speakers’ faces overlap on some frames (people sitting close, or one passing in front). Without it such a generation fails.',
  );

type Speaker = z.infer<typeof speaker>;
type AudioInput = { type: 'audio'; refId: string; url?: string; assetId?: string };

function faceSelection(face: Speaker['face'], at: string) {
  const point = face.frameNumber !== undefined || face.coordinates !== undefined;
  if (
    [point, face.boxes !== undefined, face.faceTrackUrl !== undefined].filter(Boolean).length !== 1
  )
    throw new Error(
      `${at}.face needs exactly one of frameNumber with coordinates, boxes or faceTrackUrl.`,
    );
  if (face.boxes) return { bounding_boxes: face.boxes };
  if (face.faceTrackUrl) return { bounding_boxes_url: face.faceTrackUrl };
  if (face.frameNumber === undefined || face.coordinates === undefined)
    throw new Error(`${at}.face needs both frameNumber and coordinates for a point.`);
  return { frame_number: face.frameNumber, coordinates: face.coordinates };
}

/**
 * The request parts `speakers` adds: one audio input per speaker, the API's speakers, and
 * options.allow_overlapping_boxes. Undefined without speakers.
 */
export function parseLipsyncSpeakers(
  args: Record<string, unknown>,
  request: { image: boolean; singleDriver: boolean },
):
  | { inputs: AudioInput[]; speakers: unknown[]; options: { allow_overlapping_boxes?: true } }
  | undefined {
  const speakers = lipsyncSpeakersInput.parse(args.speakers);
  const overlap = allowOverlappingFacesInput.parse(args.allowOverlappingFaces);
  if (!speakers) {
    if (overlap !== undefined) throw new Error('allowOverlappingFaces needs speakers.');
    return undefined;
  }
  if (request.image) throw new Error('speakers needs a video input.');
  if (request.singleDriver)
    throw new Error(
      'With speakers, give each speaker its own audio (speakers[].audioUrl or audioAssetId) and omit audioUrl, audioAssetId, audio and script.',
    );
  // Parsed by parseLipsyncOptions before this, so it is an object or absent.
  const options = args.options as { active_speaker_detection?: unknown } | undefined;
  if (options?.active_speaker_detection !== undefined)
    throw new Error(
      'With speakers, omit options.active_speaker_detection: each speaker’s face says who to lipsync.',
    );
  const seen = new Set<string>();
  const inputs: AudioInput[] = [];
  const mapped = speakers.map((item, index) => {
    const at = `speakers[${index}]`;
    if (item.id === 'default') throw new Error(`${at}.id cannot be "default".`);
    if (seen.has(item.id)) throw new Error(`${at}.id "${item.id}" is used twice.`);
    seen.add(item.id);
    if (Boolean(item.audioUrl) === Boolean(item.audioAssetId))
      throw new Error(`${at} needs exactly one of audioUrl or audioAssetId.`);
    inputs.push({
      type: 'audio',
      refId: item.id,
      ...(item.audioAssetId ? { assetId: item.audioAssetId } : { url: item.audioUrl }),
    });
    return { id: item.id, audio: { refId: item.id }, face: faceSelection(item.face, at) };
  });
  return {
    inputs,
    speakers: mapped,
    options: overlap ? { allow_overlapping_boxes: true } : {},
  };
}
