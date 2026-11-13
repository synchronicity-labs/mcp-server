import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, createHttpClient, resolveSyncSource } from './http-client.js';

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

describe('social import error details', () => {
  afterEach(() => vi.restoreAllMocks());

  const importJobId = '00000000-0000-4000-8000-000000000004';
  it.each([
    { importJobId: 'not-a-uuid' },
    { importStatus: 'unrecognized' },
    { progress: -1 },
    { progress: 101 },
    { progress: '50' },
  ])('preserves the API failure when import details are malformed: %j', async (patch) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          message: 'Still importing',
          errorCode: 'import_in_progress',
          importJobId,
          importStatus: 'downloading',
          progress: 50,
          ...patch,
        }),
        { status: 409, headers: { 'Retry-After': '15' } },
      ),
    );
    const failure = await createHttpClient('https://api.example.test')
      .request('post', '/v2/assets', { body: { url: 'https://youtu.be/video', type: 'VIDEO' } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).toMatchObject({
      status: 409,
      code: 'import_in_progress',
      retryAfterMs: 15_000,
      importDetails: undefined,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not attach import fields to an unrelated API error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          message: 'Conflict',
          errorCode: 'IDEMPOTENCY_CONFLICT',
          importJobId,
          importStatus: 'downloading',
          progress: 50,
        }),
        { status: 409 },
      ),
    );
    await expect(
      createHttpClient('https://api.example.test').request('post', '/v2/generate'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', importDetails: undefined });
  });
});

describe('a sign-in that renews itself', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks for its headers on every request and names the way back in once refused', async () => {
    const sent: (string | null)[] = [];
    let status = 200;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers).get('authorization'));
      return new Response('{}', { status });
    });
    let token = 'first';
    const auth = Object.assign(async () => ({ Authorization: `Bearer ${token}` }), {
      signedOutStep: 'Sign in again.',
    });
    const client = createHttpClient('https://api.test', auth);

    await client.request('get', '/v2/account');
    token = 'renewed';
    await client.request('get', '/v2/account');
    expect(sent).toEqual(['Bearer first', 'Bearer renewed']);

    status = 401;
    await expect(client.request('get', '/v2/account')).rejects.toMatchObject({
      status: 401,
      nextStep: 'Sign in again.',
    });
    status = 403;
    await expect(client.request('get', '/v2/account')).rejects.toMatchObject({
      nextStep: undefined,
    });
  });
});
