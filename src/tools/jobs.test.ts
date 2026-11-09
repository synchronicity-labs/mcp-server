import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiRequestError } from '../http-client.js';
import type { McpToolDefinition, ToolRequestContext } from './generator.js';
import { createJobTools } from './jobs.js';

type Handler = (args: Record<string, unknown>, context?: ToolRequestContext) => Promise<unknown>;

/** A fake per-kind read tool answering each call with the next response in order. */
function tool(
  name: string,
  responses: (unknown | Error)[],
  extra: Partial<McpToolDefinition> = {},
): McpToolDefinition & { handler: ReturnType<typeof vi.fn<Handler>> } {
  const queue = [...responses];
  return {
    name,
    description: name,
    inputSchema: {},
    handler: vi.fn<Handler>(async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    }),
    ...extra,
  } as McpToolDefinition & { handler: ReturnType<typeof vi.fn<Handler>> };
}

function jobs(tools: McpToolDefinition[]) {
  const [get, wait] = createJobTools(tools);
  const call = (target: McpToolDefinition | undefined, args: Record<string, unknown>) => {
    const progress = vi.fn(async (_progress: number, _message?: string) => {});
    return {
      progress,
      result: target!.handler(args, { progress }) as Promise<Record<string, unknown>>,
    };
  };
  return {
    get,
    wait,
    read: (args: Record<string, unknown>) => call(get, args),
    waitFor: (args: Record<string, unknown>) => call(wait, args),
  };
}

const importing = (importStatus: string, progress: number) =>
  new ApiRequestError(
    'API request failed: 409 Conflict - importing',
    409,
    'import_in_progress',
    0,
    undefined,
    {
      importStatus: importStatus as 'queued',
      progress,
    },
  );

describe('jobs_get and jobs_wait', () => {
  it('offer only the kinds whose read tool this server has', () => {
    expect(createJobTools([])).toEqual([]);
    const { get } = jobs([tool('generations_get', [{}]), tool('assets_create', [{}])]);
    expect(get?.name).toBe('jobs_get');
    expect((get!.inputSchema.kind as z.ZodEnum).options).toEqual(['generation', 'import']);
    expect(get!.description).toContain('- generation: the id from lipsync_create');
    expect(get!.description).not.toContain('speaker_analysis');
    expect(get!.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
  });

  it('reads a generation once with its progress, server estimate and projected result', async () => {
    const generation = tool(
      'generations_get',
      [
        {
          id: 'g-1',
          status: 'PROCESSING',
          progress: { percent: 42, estimatedTimeRemaining: 30 },
          generationEstimate: { estimatedFinishAt: '2026-11-05T10:00:00Z' },
          internal: 'not in the output schema',
        },
      ],
      {
        inputSchema: { id: z.string(), include: z.string().optional() },
        outputSchema: { id: z.string(), status: z.string(), generationEstimate: z.unknown() },
      },
    );
    const { read } = jobs([generation]);
    const { result, progress } = read({ kind: 'generation', id: 'g-1' });
    expect(await result).toEqual({
      kind: 'generation',
      id: 'g-1',
      status: 'PROCESSING',
      progress: 42,
      estimatedFinishAt: '2026-11-05T10:00:00Z',
      result: {
        id: 'g-1',
        status: 'PROCESSING',
        generationEstimate: { estimatedFinishAt: '2026-11-05T10:00:00Z' },
      },
    });
    expect(generation.handler).toHaveBeenCalledExactlyOnceWith(
      { id: 'g-1', include: 'progress' },
      expect.anything(),
    );
    expect(progress).not.toHaveBeenCalled();
  });

  it('waits for a generation, reporting progress until it completes', async () => {
    const generation = tool('generations_get', [
      { id: 'g-1', status: 'PROCESSING', progress_percent: 40 },
      { id: 'g-1', status: 'COMPLETED', outputMediaUrl: 'https://cdn.test/out.mp4' },
    ]);
    const { waitFor } = jobs([generation]);
    const { result, progress } = waitFor({ kind: 'generation', id: 'g-1' });
    expect(await result).toEqual({
      kind: 'generation',
      id: 'g-1',
      status: 'COMPLETED',
      result: { id: 'g-1', status: 'COMPLETED', outputMediaUrl: 'https://cdn.test/out.mp4' },
    });
    expect(progress.mock.calls).toEqual([[1, 'generation processing 40%']]);
    // Without an include input the read sends only the id.
    expect(generation.handler.mock.calls[0]![0]).toEqual({ id: 'g-1' });
  });

  it('returns a terminal failure at once, without waiting', async () => {
    const generation = tool('generations_get', [
      { id: 'g-2', status: 'FAILED', error: 'face not found', errorCode: 'no_face' },
    ]);
    const { waitFor } = jobs([generation]);
    const { result, progress } = waitFor({ kind: 'generation', id: 'g-2' });
    expect(await result).toMatchObject({
      status: 'FAILED',
      result: { error: 'face not found', errorCode: 'no_face' },
    });
    expect(generation.handler).toHaveBeenCalledOnce();
    expect(progress).not.toHaveBeenCalled();
  });

  it('maps a rejected generation to REJECTED', async () => {
    const { waitFor } = jobs([
      tool('generations_get', [{ id: 'g-3', status: 'REJECTED', error: 'moderation' }]),
    ]);
    expect(await waitFor({ kind: 'generation', id: 'g-3' }).result).toMatchObject({
      status: 'REJECTED',
    });
  });

  it('waits for a transcription', async () => {
    const transcription = tool('transcriptions_get', [
      { id: 't-1', status: 'PENDING' },
      { id: 't-1', status: 'COMPLETED', transcript: [] },
    ]);
    const { waitFor } = jobs([transcription]);
    const { result, progress } = waitFor({ kind: 'transcription', id: 't-1' });
    expect(await result).toMatchObject({ kind: 'transcription', status: 'COMPLETED' });
    expect(transcription.handler.mock.calls.map((call) => call[0])).toEqual([
      { id: 't-1' },
      { id: 't-1' },
    ]);
    expect(progress.mock.calls).toEqual([[1, 'transcription pending']]);
  });

  it('ends a speaker analysis that cannot run as FAILED, keeping its own status', async () => {
    const analysis = tool('transcriptions_get-speaker-analysis', [
      { status: 'processing', speakers: [] },
      { status: 'unavailable', unavailableReason: 'no_faces', speakers: [] },
    ]);
    const { waitFor } = jobs([analysis]);
    expect(await waitFor({ kind: 'speaker_analysis', id: 't-1' }).result).toEqual({
      kind: 'speaker_analysis',
      id: 't-1',
      status: 'FAILED',
      result: { status: 'unavailable', unavailableReason: 'no_faces', speakers: [] },
    });
  });

  it('reads a translation preview in its project and stops when it needs recovery', async () => {
    const preview = tool('translation-previews_get', [
      { id: 'p-1', status: 'COMPLETING', recoveryRequired: true },
    ]);
    const { waitFor } = jobs([preview]);
    await expect(waitFor({ kind: 'translation_preview', id: 'p-1' }).result).rejects.toThrow(
      'Pass the projectId',
    );
    const { result, progress } = waitFor({
      kind: 'translation_preview',
      id: 'p-1',
      projectId: 'project-1',
    });
    expect(await result).toMatchObject({
      status: 'PROCESSING',
      result: { recoveryRequired: true },
    });
    expect(preview.handler).toHaveBeenCalledExactlyOnceWith(
      { projectId: 'project-1', id: 'p-1' },
      expect.anything(),
    );
    expect(progress).not.toHaveBeenCalled();
  });

  it('waits through import_in_progress until the asset is saved', async () => {
    const assets = tool('assets_create', [
      importing('queued', 0),
      importing('downloading', 60),
      { id: 'asset-1', type: 'VIDEO' },
    ]);
    const { waitFor } = jobs([assets]);
    const link = 'https://youtu.be/example';
    const { result, progress } = waitFor({
      kind: 'import',
      id: link,
      projectId: 'project-1',
      projectIntent: 'explicit',
    });
    expect(await result).toEqual({
      kind: 'import',
      id: link,
      status: 'COMPLETED',
      result: { id: 'asset-1', type: 'VIDEO' },
    });
    expect(assets.handler.mock.calls.map((call) => call[0])).toEqual(
      Array.from({ length: 3 }, () => ({
        url: link,
        type: 'VIDEO',
        projectId: 'project-1',
        projectIntent: 'explicit',
      })),
    );
    expect(progress.mock.calls).toEqual([
      [1, 'import pending 0%'],
      [2, 'import processing 60%'],
    ]);
  });

  it('reports a running import with its pause, and import failures as job states', async () => {
    const pending = importing('downloading', 25);
    const read = (error: Error) =>
      jobs([tool('assets_create', [error])]).read({ kind: 'import', id: 'https://youtu.be/x' })
        .result;
    expect(await read(pending)).toEqual({
      kind: 'import',
      id: 'https://youtu.be/x',
      status: 'PROCESSING',
      progress: 25,
      retryAfterMs: 0,
      result: {
        code: 'import_in_progress',
        message: pending.message,
        importStatus: 'downloading',
        progress: 25,
      },
    });
    expect(
      await read(new ApiRequestError('API request failed: 422 - gone', 422, 'import_failed')),
    ).toMatchObject({
      status: 'FAILED',
      result: { error: { status: 422, code: 'import_failed' } },
    });
    expect(
      await read(new ApiRequestError('limit', 429, 'import_daily_limit_reached')),
    ).toMatchObject({ status: 'REJECTED' });
    // Errors that are not about the import stay tool errors.
    await expect(
      read(new ApiRequestError('intent', 400, 'PROJECT_INTENT_REQUIRED')),
    ).rejects.toThrow('intent');
  });

  it('rejects an unknown kind or a missing id', async () => {
    const { read } = jobs([tool('generations_get', [{}])]);
    await expect(read({ kind: 'transcription', id: 't-1' }).result).rejects.toThrow();
    await expect(read({ kind: 'generation', id: ' ' }).result).rejects.toThrow();
  });
});
