import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient, type HttpClient, UPSTREAM_REQUEST_TIMEOUT_MS } from './http-client.js';
import { registerTools } from './server.js';
import { createAppTools } from './tools/app-tools.js';
import { generateTools, type ToolRequestContext } from './tools/generator.js';
import { UploadRuntime } from './upload-runtime.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function runtime() {
  return new UploadRuntime({
    maxBytes: 100,
    maxConcurrent: 1,
    maxQueued: 1,
    timeoutMs: 10_000,
    retryAfterMs: 1000,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('explicit MCP cancellation', () => {
  it.each([
    true,
    false,
  ])('stops after project search even if the upstream ignores abort (existing=%s)', async (existing) => {
    const started = deferred<AbortSignal>();
    const result = deferred<{ items: Array<{ id: string; name: string }> }>();
    const finished = deferred<void>();
    const request = vi.fn<HttpClient['request']>(async (_method, path, options) => {
      if (path === '/v2/projects') {
        if (!options?.signal) throw new Error('missing request cancellation');
        started.resolve(options.signal);
        return result.promise;
      }
      throw new Error(`unexpected write: ${path}`);
    });
    const server = new McpServer({ name: 'cancellation-test', version: '1' });
    const tools = createAppTools({ request }).map((tool) => {
      if (tool.name !== 'create-lipsync' || tool.resultFormat === 'mcp') return tool;
      return {
        ...tool,
        handler: async (args: Record<string, unknown>, context?: ToolRequestContext) => {
          try {
            return await tool.handler(args, context);
          } finally {
            finished.resolve();
          }
        },
      };
    });
    registerTools(server, tools);
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const cancel = new AbortController();
    try {
      const call = client.callTool(
        {
          name: 'create-lipsync',
          arguments: { videoAssetId: 'owned-video', audioAssetId: 'owned-audio' },
        },
        undefined,
        { signal: cancel.signal },
      );
      const rejected = expect(call).rejects.toThrow();
      const upstreamSignal = await started.promise;
      cancel.abort(new Error('user cancelled'));
      await rejected;
      expect(upstreamSignal.aborted).toBe(true);
      result.resolve({ items: existing ? [{ id: 'project', name: 'Sync generations' }] : [] });
      await finished.promise;
      expect(request.mock.calls.map(([method, path]) => [method, path])).toEqual([
        ['get', '/v2/projects'],
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('removes an explicitly cancelled upload from admission without consuming a slot', async () => {
    const uploads = runtime();
    const gate = deferred<void>();
    const active = uploads.run(() => gate.promise);
    const cancelled = new AbortController();
    const operation = vi.fn(async () => 'never');
    const queued = uploads.run(operation, { signal: cancelled.signal });
    const rejected = expect(queued).rejects.toThrow('cancelled');
    cancelled.abort(new Error('cancelled'));
    await rejected;
    expect(uploads.snapshot()).toMatchObject({ active: 1, queued: 0, failed: 0 });
    gate.resolve();
    await active;
    expect(operation).not.toHaveBeenCalled();
    expect(uploads.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('checks cancellation after admission before starting work', async () => {
    const uploads = runtime();
    const cancel = new AbortController();
    const operation = vi.fn(async () => 'never');
    const pending = uploads.run(operation, { signal: cancel.signal });
    cancel.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(operation).not.toHaveBeenCalled();
    expect(uploads.snapshot()).toMatchObject({ active: 0, queued: 0, completed: 0, failed: 0 });
  });

  it('passes cancellation through a generated long-poll read without changing query parameters', async () => {
    const request = vi.fn<HttpClient['request']>().mockResolvedValue({ status: 'COMPLETED' });
    const [tool] = generateTools(
      [
        {
          operationId: 'Generate_get',
          method: 'get',
          path: '/v2/generate/{id}',
          summary: 'Get result',
          tags: [],
          isMultipart: false,
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'wait', in: 'query', required: false, schema: { type: 'boolean' } },
            { name: 'timeout', in: 'query', required: false, schema: { type: 'number' } },
          ],
        },
      ],
      { request },
    );
    const signal = new AbortController().signal;
    await expect(
      tool?.handler({ id: 'generation', wait: true, timeout: 55 }, { signal }),
    ).resolves.toEqual({ status: 'COMPLETED' });
    expect(request).toHaveBeenCalledWith('get', '/v2/generate/generation', {
      query: { wait: 'true', timeout: '55' },
      body: undefined,
      signal,
    });
  });

  it('does not dispatch a pre-cancelled upstream write', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      createHttpClient('https://example.test').request('post', '/v2/generate', {
        signal: AbortSignal.abort(new Error('cancelled')),
      }),
    ).rejects.toThrow('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds stalled upstream requests without retries, allowing a 55-second poll', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    // Node's native AbortSignal.timeout uses its own clock; substitute only its timer.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms);
      return controller.signal;
    });
    try {
      const pending = createHttpClient('https://example.test').request('get', '/v2/generate/id');
      const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(55_000);
      expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(UPSTREAM_REQUEST_TIMEOUT_MS - 55_000);
      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });
});
