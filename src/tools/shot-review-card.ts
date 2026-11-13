import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import { whenEnabled } from './asset-analysis.js';
import type { McpToolDefinition } from './generator.js';
import { baseGeneration, retakeSources } from './shot-review.js';

const shot = z
  .object({
    startFrame: z.number().int().nonnegative().describe('First frame of the shot, from 0.'),
    endFrame: z
      .number()
      .int()
      .positive()
      .describe('Frame after the shot’s last one (exclusive): the next shot’s startFrame.'),
  })
  .strict();

// What a take is built from, plus the fields of include=progress the review card shows.
const reviewed = baseGeneration.extend({
  outputUrl: z.string().nullish(),
  outputMediaUrl: z.string().nullish(),
  summary: z.object({ title: z.string().optional() }).optional().catch(undefined),
});

/**
 * Opens the shot review card on a finished generation. It only reads: the card renders
 * shots again (shots_regenerate) and builds the final video (shots_splice) itself, when the
 * person presses its buttons.
 */
export function createShotReviewCardTool(http: HttpClient): McpToolDefinition {
  const input = z
    .object({
      generationId: z
        .uuid()
        .describe(
          'Id of the completed lipsync or dub the person wants to review: the first render.',
        ),
      shots: z
        .array(shot)
        .min(1)
        .max(500)
        .describe(
          'Every shot of the video, in order, without gaps or overlaps, from frame 0 to frameCount: faces_get-timeline shots as is, or scenes_detect scenes with 1 added to each endFrame.',
        ),
      fps: z
        .number()
        .positive()
        .describe('Frame rate of the video, from the same result as the shots. Never guess it.'),
      frameCount: z
        .number()
        .int()
        .positive()
        .describe('Frames in the video, from the same result as the shots.'),
    })
    .strict();
  return {
    name: 'shots_review',
    title: 'Review a generation shot by shot',
    description:
      'Show the person a finished lipsync or dub cut into its shots, as a card where they play each shot, flag the ones that look wrong and say why, render only those again, compare each new take with the first render, and build the final video. Use it when the person says a finished video looks wrong in places or asks to review, fix or redo parts of it. It refuses, with the reason and the alternative, a generation whose shots cannot be rendered again: one that is not COMPLETED, was made from timeline clips, several speakers or a script, or whose length differs from the video’s. Get the shots, fps and frameCount first from faces_get-timeline (after faces_detect) or scenes_detect on the generation’s video. This tool only reads and opens the card: the card’s own buttons start the paid render of the flagged shots and the free final build, and each time it tells you the ids, so never call shots_regenerate or shots_splice yourself for a review the card is running. Returns the generation’s video, its source video, and the shots as given.',
    inputSchema: input.shape,
    outputSchema: {
      reviewId: z
        .string()
        .describe(
          'Made new by each call. The card works the idempotency key of each take out from it, so reloading the card cannot start a take twice and a review opened again is new work.',
        ),
      generationId: z.uuid().describe('The first render under review.'),
      title: z.string().optional().describe('The generation’s title, when it has one.'),
      videoUrl: z.string().describe('The first render’s video.'),
      sourceUrl: z.string().optional().describe('The untouched source video, to compare against.'),
      fps: z.number(),
      frameCount: z.number(),
      shots: z.array(shot),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: (rawArgs, context) =>
      whenEnabled('Shot review', async () => {
        const args = input.parse(rawArgs);
        let expected = 0;
        args.shots.forEach((range, index) => {
          if (range.startFrame !== expected || range.endFrame <= range.startFrame)
            throw new Error(
              `shots[${index}] must start at frame ${expected} and end after it: give every shot of the video, in order, with exclusive endFrames.`,
            );
          expected = range.endFrame;
        });
        if (expected !== args.frameCount)
          throw new Error(
            `The shots end at frame ${expected} but the video has ${args.frameCount} frames. Give every shot up to frameCount.`,
          );
        const generation = reviewed.parse(
          await http.request('get', `/v2/generate/${args.generationId}`, {
            query: { include: 'progress' },
            signal: context?.signal,
          }),
        );
        // The card's paid step is shots_regenerate. Refuse here what it would refuse, with
        // its reason, before anyone spends time flagging shots that cannot be redone.
        retakeSources(generation, args);
        const videoUrl = generation.outputMediaUrl ?? generation.outputUrl;
        if (!videoUrl) throw new Error(`Generation ${generation.id} has no video to review.`);
        const sourceUrl = generation.input.find((item) => item.type === 'video')?.url;
        return {
          reviewId: randomUUID(),
          generationId: generation.id,
          ...(generation.summary?.title ? { title: generation.summary.title } : {}),
          videoUrl,
          ...(sourceUrl ? { sourceUrl } : {}),
          fps: args.fps,
          frameCount: args.frameCount,
          shots: args.shots,
        };
      }),
  };
}
