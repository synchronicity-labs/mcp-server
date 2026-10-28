import { describe, expect, it, vi } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createAnalyticsTool, trackToolExecution } from './chatgpt-analytics.js';
import { createHttpClient } from './http-client.js';

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

  it('returns the original successful result when telemetry rejects', async () => {
    const http = { request: vi.fn().mockRejectedValue(new Error('offline')) };
    await expect(
      trackToolExecution('create-lipsync', {}, undefined, 'chatgpt', http, async () => ({
        id: 'accepted',
      })),
    ).resolves.toEqual({ id: 'accepted' });
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
