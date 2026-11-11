import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import { adaptGeneratedTool } from './generated-adapters.js';
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
    await tool.handler({ id: 'generation', include: 'progress' });
    expect(request.mock.calls[1]?.[2]?.query).toEqual({ include: 'progress' });
  });

  it('reads once without wait', async () => {
    const request = vi.fn<HttpClient['request']>(async () => ({
      id: 'generation',
      status: 'PROCESSING',
    }));
    await expect(generationsGet(request).handler({ id: 'generation' })).resolves.toMatchObject({
      status: 'PROCESSING',
    });
    expect(request).toHaveBeenCalledOnce();
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
