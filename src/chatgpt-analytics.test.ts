import { describe, expect, it, vi } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import {
  createAnalyticsTool,
  toolAnalyticsSupport,
  trackToolExecution,
} from './chatgpt-analytics.js';
import { ApiRequestError, createHttpClient } from './http-client.js';
import type { ParsedOperation } from './openapi/types.js';

const journey = '22222222-2222-4222-8222-222222222222';
describe('ChatGPT analytics transport', () => {
  it('isolates concurrent callers and never forwards telemetry as business arguments', async () => {
    const calls: Array<{ source: string | null; analytics: string | null }> = [];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        source: headers.get('x-sync-source'),
        analytics: headers.get('x-sync-analytics'),
      });
      return new Response('{}');
    });
    const http = createHttpClient('https://fixture.invalid');
    try {
      await runWithAuth('fixture-token', 'openai-mcp', () =>
        Promise.all([
          trackToolExecution(
            'create-lipsync',
            { syncAnalytics: { version: 1, invocation_source: 'ui', journey_id: journey } },
            { 'openai/session': 'private-conversation' },
            'chatgpt',
            http,
            async (args) => {
              expect(args).toEqual({});
              await Promise.resolve();
              return http.request('post', '/v2/generate');
            },
          ),
          trackToolExecution('projects_get-all', {}, undefined, 'chatgpt', http, () =>
            http.request('get', '/v2/projects'),
          ),
        ]),
      );
      expect(JSON.parse(calls[0]?.analytics ?? '{}')).toMatchObject({
        invocation_source: 'unknown',
      });
      expect(
        calls.some((call) => JSON.parse(call.analytics ?? '{}').invocation_source === 'ui'),
      ).toBe(true);
      expect(JSON.stringify(calls)).not.toContain('private-conversation');
      expect(calls.every((call) => call.source === 'mcp:openai-mcp')).toBe(true);
    } finally {
      fetcher.mockRestore();
    }
  });

  it('sends only the tools and error fields the deployed API schema lists', () => {
    const operation = (properties: Record<string, unknown>): ParsedOperation[] => [
      {
        operationId: 'analytics_captureChatgptEvent',
        method: 'post',
        path: '/v2/analytics/chatgpt-events',
        summary: '',
        tags: [],
        parameters: [],
        isMultipart: false,
        requestBody: { contentType: 'application/json', schema: { properties } },
      },
    ];
    expect(toolAnalyticsSupport([])).toBeUndefined();
    expect(toolAnalyticsSupport(operation({ tool_name: { enum: ['create-lipsync'] } }))).toEqual({
      tools: new Set(['create-lipsync']),
      errorDetails: false,
    });
    expect(
      toolAnalyticsSupport(
        operation({
          tool_name: { enum: ['upload-media'] },
          error_source: {},
          error_status: {},
          error_code: {},
        }),
      ),
    ).toEqual({ tools: new Set(['upload-media']), errorDetails: true });
    const [wrapped] = operation({});
    wrapped!.requestBody!.schema = {
      allOf: [
        { properties: { tool_name: { enum: ['upload-media'] } } },
        { properties: { error_source: {}, error_status: {}, error_code: {} } },
      ],
    };
    expect(toolAnalyticsSupport([wrapped!])).toEqual({
      tools: new Set(['upload-media']),
      errorDetails: true,
    });
  });

  it.each([
    [
      'an API rejection',
      async (http: ReturnType<typeof createHttpClient>) => http.request('post', '/v2/generate'),
      { error_source: 'api', error_status: 429, error_code: 'concurrency_limit_reached' },
    ],
    [
      "this server's own check",
      async () => {
        throw new ApiRequestError('pick a project', 400, 'PROJECT_INTENT_REQUIRED');
      },
      { error_source: 'mcp', error_status: 400, error_code: 'PROJECT_INTENT_REQUIRED' },
    ],
    [
      'an error whose code is free text',
      async () => {
        throw new ApiRequestError('bad', 422, 'Unprocessable Entity');
      },
      { error_source: 'mcp', error_status: 422 },
    ],
  ])('records why a call failed after %s, without its message', async (_case, fail, details) => {
    const events: unknown[] = [];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((url instanceof Request ? url.url : url.toString()).endsWith('/chatgpt-events')) {
        events.push(JSON.parse(init?.body as string));
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({ errorCode: 'concurrency_limit_reached', message: 'Your script: hi' }),
        { status: 429 },
      );
    });
    const http = createHttpClient('https://fixture.invalid');
    const analytics = { tools: new Set(['create-lipsync']), errorDetails: true };
    try {
      await expect(
        trackToolExecution(
          'create-lipsync',
          {},
          undefined,
          'chatgpt',
          http,
          () => fail(http),
          analytics,
        ),
      ).rejects.toThrow();
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]).toMatchObject({ tool_name: 'create-lipsync', outcome: 'error' });
      const { error_source, error_status, error_code } = events[0] as Record<string, unknown>;
      expect(
        Object.fromEntries(
          Object.entries({ error_source, error_status, error_code }).filter(([, v]) => v),
        ),
      ).toEqual(details);
      expect(JSON.stringify(events[0])).not.toContain('Your script');
    } finally {
      fetcher.mockRestore();
    }
  });

  it('sends no event for a tool the API schema does not list', async () => {
    const http = { request: vi.fn().mockResolvedValue(undefined) };
    await trackToolExecution('upload-media', {}, undefined, 'chatgpt', http, async () => ({}), {
      tools: new Set(['create-lipsync']),
      errorDetails: true,
    });
    expect(http.request).not.toHaveBeenCalled();
  });

  it('returns the original successful result when telemetry rejects', async () => {
    const http = { request: vi.fn().mockRejectedValue(new Error('offline')) };
    await expect(
      trackToolExecution(
        'create-lipsync',
        {},
        undefined,
        'chatgpt',
        http,
        async () => ({ id: 'accepted' }),
        { tools: new Set(['create-lipsync']), errorDetails: true },
      ),
    ).resolves.toEqual({ id: 'accepted' });
    expect(http.request).toHaveBeenCalledWith(
      'post',
      '/v2/analytics/chatgpt-events',
      expect.objectContaining({ body: expect.objectContaining({ outcome: 'success' }) }),
    );
  });

  it('bounds UI telemetry and strips identity before the authenticated HTTP request', async () => {
    const http = { request: vi.fn().mockResolvedValue(undefined) };
    const tool = createAnalyticsTool(http);
    await expect(
      tool.handler({
        event: 'chatgpt_ui_loaded',
        event_id: journey,
        attribution: { version: 1, invocation_source: 'ui', journey_id: journey },
        user_id: journey,
      }),
    ).rejects.toThrow();
    expect(http.request).not.toHaveBeenCalled();
  });
});
