import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiRequestError } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';
import { createJobsGetManyTool } from './jobs-get-many.js';

/** A fake read tool answering each id with its next status in order. */
function reader(name: string, statuses: Record<string, string[]>) {
  const handler = vi.fn(async (args: Record<string, unknown>) => {
    const queue = statuses[String(args.id)]!;
    return { id: args.id, status: queue.length > 1 ? queue.shift() : queue[0] };
  });
  return { name, description: name, inputSchema: {}, handler } as McpToolDefinition & {
    handler: typeof handler;
  };
}

describe('jobs_get-many', () => {
  it('offers the preview kinds jobs_get leaves out, with only the fields they need', () => {
    expect(createJobsGetManyTool([])).toEqual([]);
    const [tool] = createJobsGetManyTool([
      reader('generations_get', {}),
      reader('dialogue-previews_get', {}),
    ]);
    const job = (tool!.inputSchema.jobs as z.ZodArray<z.ZodObject>).element;
    expect((job.shape.kind as z.ZodEnum).options).toEqual(['generation', 'dialogue_preview']);
    expect(Object.keys(job.shape)).toEqual(['kind', 'id', 'projectId', 'videoAssetId']);
  });

  it('waits until every job is final, reading again only the running ones', async () => {
    const generations = reader('generations_get', {
      a: ['COMPLETED'],
      b: ['PROCESSING', 'COMPLETED'],
    });
    const speech = reader('speech-previews_get', { s: ['SUCCESS'] });
    const [tool] = createJobsGetManyTool([generations, speech]);
    const progress = vi.fn(async (_progress: number, _message?: string) => {});
    const result = (await tool!.handler(
      {
        wait: true,
        jobs: [
          { kind: 'generation', id: 'a' },
          { kind: 'generation', id: 'b' },
          { kind: 'speech_preview', id: 's', projectId: 'p-1' },
          // A preview read needs its projectId; that job alone comes back unreadable.
          { kind: 'speech_preview', id: 's' },
        ],
      },
      { progress },
    )) as {
      jobs: { status?: string; error?: { message: string } }[];
      counts: Record<string, number>;
    };
    expect(result.jobs.map((job) => job.status)).toEqual([
      'COMPLETED',
      'COMPLETED',
      'COMPLETED',
      undefined,
    ]);
    expect(result.jobs[3]!.error!.message).toContain('projectId');
    expect(result.counts).toEqual({ total: 4, running: 0, completed: 3, failed: 0, unreadable: 1 });
    expect(generations.handler.mock.calls.map(([args]) => args.id)).toEqual(['a', 'b', 'b']);
    expect(progress).toHaveBeenCalledWith(1, '3 of 4 jobs final');
  });

  it('waits out each job’s own retryAfterMs, reading the others on the shared backoff', async () => {
    const generations = reader('generations_get', {
      g: ['PROCESSING', 'PROCESSING', 'COMPLETED'],
    });
    const importReads: number[] = [];
    const assets = {
      name: 'assets_create',
      description: 'assets_create',
      inputSchema: {},
      handler: vi.fn(async () => {
        importReads.push(Date.now());
        if (importReads.length === 1)
          throw new ApiRequestError('importing', 409, 'import_in_progress', 1_500);
        return { id: 'asset-1', type: 'VIDEO' };
      }),
    } as McpToolDefinition;
    const [tool] = createJobsGetManyTool([generations, assets]);
    const result = (await tool!.handler({
      wait: true,
      jobs: [
        { kind: 'generation', id: 'g' },
        { kind: 'import', id: 'https://youtu.be/x' },
      ],
    })) as { jobs: { status?: string }[] };
    expect(result.jobs.map((job) => job.status)).toEqual(['COMPLETED', 'COMPLETED']);
    // The generation was read on the 1 s backoff; the import only after its 1.5 s pause.
    expect(generations.handler).toHaveBeenCalledTimes(3);
    expect(importReads).toHaveLength(2);
    expect(importReads[1]! - importReads[0]!).toBeGreaterThanOrEqual(1_500);
  }, 10_000);
});
