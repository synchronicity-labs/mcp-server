import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import { runWithToolAnalytics } from '../tool-analytics-context.js';
import { adaptGeneratedTool, STALLED_NEXT_STEP, stalledSince } from './generated-adapters.js';
import { generateTools } from './generator.js';
import { WAIT_BUDGET_MS } from './job-wait.js';

const operation: ParsedOperation = {
  operationId: 'GenerateController_getGeneration',
  method: 'get',
  path: '/v2/generate/{id}',
  summary: 'Get a generation',
  tags: ['Generate'],
  isMultipart: false,
  parameters: [
    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    { name: 'wait', in: 'query', required: false, schema: { type: 'boolean' } },
    { name: 'timeout', in: 'query', required: false, schema: { type: 'number' } },
    {
      name: 'include',
      in: 'query',
      required: false,
      schema: { type: 'string', enum: ['progress'] },
    },
  ],
};

function generationsGet(request: HttpClient['request']) {
  const http = { request } as HttpClient;
  const [tool] = generateTools([operation], http);
  const adapted = adaptGeneratedTool(tool!, operation, http);
  if (adapted.resultFormat === 'mcp') throw new Error('Expected a JSON tool');
  return adapted;
}

afterEach(() => vi.useRealTimers());

describe('generations_get wait', () => {
  it('keeps reading on the server until the generation settles', async () => {
    const statuses = ['PENDING', 'PROCESSING', 'COMPLETED'];
    const request = vi.fn<HttpClient['request']>(async () => ({
      id: 'generation',
      status: statuses.shift(),
    }));
    const tool = generationsGet(request);
    vi.useFakeTimers();
    const result = tool.handler({ id: 'generation', wait: true, timeout: 10 });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(request).toHaveBeenCalledTimes(3);
    // Each read is the API's own long-poll, with the caller's input unchanged.
    for (const [, path, options] of request.mock.calls) {
      expect(path).toBe('/v2/generate/generation');
      expect(options?.query).toEqual({ wait: 'true', timeout: '10' });
    }
  });

  it('drops include=progress while waiting, which the API refuses with wait', async () => {
    const request = vi.fn<HttpClient['request']>(async () => ({
      id: 'generation',
      status: 'COMPLETED',
    }));
    const tool = generationsGet(request);
    await expect(
      tool.handler({ id: 'generation', wait: true, include: 'progress' }),
    ).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(request.mock.calls[0]?.[2]?.query).toEqual({ wait: 'true' });
  });

  it('waits when the agent asks for progress and leaves wait out', async () => {
    const statuses = ['PROCESSING', 'COMPLETED'];
    const request = vi.fn<HttpClient['request']>(async () => ({
      id: 'generation',
      status: statuses.shift(),
    }));
    vi.useFakeTimers();
    const result = generationsGet(request).handler({ id: 'generation', include: 'progress' });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(request).toHaveBeenCalledTimes(2);
    for (const [, , options] of request.mock.calls)
      expect(options?.query).toEqual({ wait: 'true' });
  });

  it('reads progress once more when the wait ends unfinished', async () => {
    const request = vi.fn<HttpClient['request']>(async (_method, _path, options) => ({
      id: 'generation',
      status: 'PROCESSING',
      ...(options?.query?.include === 'progress' ? { progress: { percent: 40 } } : {}),
    }));
    vi.useFakeTimers();
    const result = generationsGet(request).handler({ id: 'generation', include: 'progress' });
    await vi.advanceTimersByTimeAsync(WAIT_BUDGET_MS + 15_000);
    await expect(result).resolves.toMatchObject({
      status: 'PROCESSING',
      progress: { percent: 40 },
    });
    expect(request.mock.calls.at(-1)?.[2]?.query).toEqual({ include: 'progress' });
  });

  it('reads progress without wait after an explicit wait ends unfinished', async () => {
    const request = vi.fn<HttpClient['request']>(async () => ({
      id: 'generation',
      status: 'PROCESSING',
    }));
    vi.useFakeTimers();
    const result = generationsGet(request).handler({
      id: 'generation',
      wait: true,
      include: 'progress',
    });
    await vi.advanceTimersByTimeAsync(WAIT_BUDGET_MS + 15_000);
    await expect(result).resolves.toMatchObject({ status: 'PROCESSING' });
    expect(request.mock.calls.at(-1)?.[2]?.query).toEqual({ include: 'progress' });
  });

  it('keeps the wait’s last read when the progress read fails', async () => {
    const request = vi.fn<HttpClient['request']>(async (_method, _path, options) => {
      if (options?.query?.include === 'progress') throw new Error('slow API');
      return { id: 'generation', status: 'PROCESSING' };
    });
    vi.useFakeTimers();
    const result = generationsGet(request).handler({ id: 'generation', include: 'progress' });
    await vi.advanceTimersByTimeAsync(WAIT_BUDGET_MS + 15_000);
    await expect(result).resolves.toMatchObject({ status: 'PROCESSING' });
  });

  it('reads once with wait: false', async () => {
    const request = vi.fn<HttpClient['request']>(async () => ({
      id: 'generation',
      status: 'PROCESSING',
    }));
    await expect(
      generationsGet(request).handler({ id: 'generation', wait: false }),
    ).resolves.toMatchObject({ status: 'PROCESSING' });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[2]?.query).toBeUndefined();
  });

  it('waits when the agent leaves wait out', async () => {
    const statuses = ['PROCESSING', 'COMPLETED'];
    const request = vi.fn<HttpClient['request']>(async () => ({
      id: 'generation',
      status: statuses.shift(),
    }));
    vi.useFakeTimers();
    const result = generationsGet(request).handler({ id: 'generation' });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[2]?.query).toEqual({ wait: 'true' });
  });

  it('reads once for the status card, which calls the old name', async () => {
    const request = vi.fn<HttpClient['request']>(async () => ({
      id: 'generation',
      status: 'PROCESSING',
    }));
    await generationsGet(request).handler(
      { id: 'generation' },
      { calledAs: 'generate_get-generation' },
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[2]?.query).toBeUndefined();
  });

  it('reads once for a widget call ChatGPT tags', async () => {
    const request = vi.fn<HttpClient['request']>(async () => ({
      id: 'generation',
      status: 'PROCESSING',
    }));
    await runWithToolAnalytics({ version: 1, invocation_source: 'background' }, () =>
      generationsGet(request).handler({ id: 'generation' }),
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it('stops waiting and says so once a generation runs past supportAt', async () => {
    const request = vi.fn<HttpClient['request']>(async () => ({
      id: 'generation',
      status: 'PROCESSING',
      generationEstimate: {
        supportAt: '2026-11-17T10:00:00.000Z',
        serverTime: '2026-11-17T10:30:00.000Z',
      },
    }));
    const result = await generationsGet(request).handler({ id: 'generation' });
    expect(request).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'PROCESSING',
      stalled: { since: '2026-11-17T10:00:00.000Z', nextStep: STALLED_NEXT_STEP },
    });
  });

  it('does not flag a generation before supportAt or once it is final', () => {
    const estimate = (serverTime: string) => ({
      supportAt: '2026-11-17T10:00:00.000Z',
      serverTime,
    });
    expect(
      stalledSince({ status: 'PROCESSING', generationEstimate: estimate('2026-11-17T09:59:00Z') }),
    ).toBeUndefined();
    expect(
      stalledSince({ status: 'COMPLETED', generationEstimate: estimate('2026-11-17T11:00:00Z') }),
    ).toBeUndefined();
    expect(stalledSince({ status: 'PENDING' })).toBeUndefined();
  });

  it('returns the latest state once the wait budget runs out', async () => {
    const request = vi.fn<HttpClient['request']>(async () => ({
      id: 'generation',
      status: 'PROCESSING',
    }));
    const tool = generationsGet(request);
    vi.useFakeTimers();
    const result = tool.handler({ id: 'generation', wait: true });
    await vi.advanceTimersByTimeAsync(WAIT_BUDGET_MS + 1_000);
    await expect(result).resolves.toMatchObject({ status: 'PROCESSING' });
    expect(request.mock.calls.length).toBeGreaterThan(1);
    expect(request.mock.calls.length).toBeLessThan(20);
  });
});

describe('generations_get on NO_OP', () => {
  it('offers a retry that reuses the audio the take already paid for', () => {
    const { description } = generationsGet(vi.fn());
    expect(description).toContain('offer to try again');
    expect(description).toContain('generations_get-continuation');
    expect(description).toContain('never its script or dub request');
    expect(description).toContain('Choose the tool from its segments');
  });
});
