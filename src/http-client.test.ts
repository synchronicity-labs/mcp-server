import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient, resolveSyncSource } from './http-client.js';

describe('resolveSyncSource', () => {
  it('maps flagship assistant clients to first-class sources', () => {
    expect(resolveSyncSource('chatgpt')).toBe('chatgpt');
    expect(resolveSyncSource('ChatGPT')).toBe('chatgpt');
    expect(resolveSyncSource('openai')).toBe('chatgpt');
    expect(resolveSyncSource('claude')).toBe('claude');
    expect(resolveSyncSource('Claude')).toBe('claude');
    expect(resolveSyncSource('gemini')).toBe('gemini');
  });

  it('namespaces every other MCP client under mcp:<client>', () => {
    expect(resolveSyncSource('openai-mcp')).toBe('mcp:openai-mcp');
    expect(resolveSyncSource('OpenAI-MCP')).toBe('mcp:OpenAI-MCP');
    expect(resolveSyncSource('cursor')).toBe('mcp:cursor');
    expect(resolveSyncSource('zed')).toBe('mcp:zed');
    expect(resolveSyncSource('openai-mcp.evil')).toBe('mcp:openai-mcp.evil');
  });

  it('falls back to bare mcp when no client name is known', () => {
    expect(resolveSyncSource(undefined)).toBe('mcp');
  });
});

afterEach(() => vi.unstubAllGlobals());
it.each([
  'claude',
  'claude-ai',
  'chatgpt',
  'openai',
  'gemini',
])('keeps bearer authentication compatible with the deployed API for %s', async (name) => {
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    // The API selects its bearer auth path only for mcp and mcp:* sources.
    if (
      headers.get('authorization') === 'Bearer session' &&
      headers.get('x-sync-source')?.startsWith('mcp:')
    ) {
      return Response.json([{ name: 'sync-3' }]);
    }
    return Response.json(
      { message: 'Either Cookie or x-api-key header must be provided' },
      { status: 401 },
    );
  });
  const client = createHttpClient(
    'https://fixture.invalid',
    { Authorization: 'Bearer session' },
    () => name,
  );
  await expect(client.request('get', '/v2/models')).resolves.toEqual([{ name: 'sync-3' }]);
});
