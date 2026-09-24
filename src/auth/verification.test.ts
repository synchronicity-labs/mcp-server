import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOAuthProvider } from './oauth-provider.js';

const valid = { sub: 'user', client_id: 'client', expires_at: 4000000000 };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('userinfo verification regression', () => {
  it.each([429, 500, 502, 503])('preserves dependency failure %s', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status })),
    );
    await expect(
      createOAuthProvider('https://fixture.invalid').verifyAccessToken('fake-token'),
    ).rejects.not.toBeInstanceOf(InvalidTokenError);
  });
  it.each([
    {},
    null,
    { ...valid, client_id: '' },
    { ...valid, expires_at: '4000000000' },
  ])('rejects malformed successful body %j', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body)),
    );
    await expect(
      createOAuthProvider('https://fixture.invalid').verifyAccessToken('fake-token'),
    ).rejects.toThrow();
  });
});

it.each([401, 403])('reserves invalid token for upstream %s', async (status) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status })),
  );
  await expect(
    createOAuthProvider('https://fixture.invalid').verifyAccessToken('fake-token'),
  ).rejects.toBeInstanceOf(InvalidTokenError);
});
it('preserves valid token identity and expiration', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(valid)),
  );
  await expect(
    createOAuthProvider('https://fixture.invalid').verifyAccessToken('fake-token'),
  ).resolves.toEqual({
    token: 'fake-token',
    clientId: 'client',
    expiresAt: valid.expires_at,
    scopes: [],
  });
});
it('retains the uncached legacy expiry fallback', async () => {
  const fetchMock = vi.fn(async () => Response.json({ sub: 'user', client_id: 'client' }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = createOAuthProvider('https://fixture.invalid');
  const info = await provider.verifyAccessToken('fake-token');
  expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000 + 3598);
  await provider.verifyAccessToken('fake-token');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it.each(['network', 'json'])('sanitizes %s errors', async (kind) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (kind === 'network') throw new Error('fake-token secret upstream detail');
      return new Response('not json fake-token');
    }),
  );
  await expect(
    createOAuthProvider('https://fixture.invalid').verifyAccessToken('fake-token'),
  ).rejects.toMatchObject({
    errorCode: 'temporarily_unavailable',
    message: 'Token verification is temporarily unavailable',
  });
});
it.each(['headers', 'body'])('bounds stalled %s even if the mock ignores abort', async (stage) => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      signal = init.signal;
      if (stage === 'headers') return new Promise(() => {});
      return { ok: true, json: () => new Promise(() => {}) };
    }),
  );
  const result = createOAuthProvider('https://fixture.invalid').verifyAccessToken('fake-token');
  const assertion = expect(result).rejects.toMatchObject({ status: 503 });
  await vi.advanceTimersByTimeAsync(5000);
  await assertion;
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it('does not dispatch pre-cancelled verification', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const controller = new AbortController();
  controller.abort();
  await expect(
    createOAuthProvider('https://fixture.invalid').verifyAccessToken(
      'fake-token',
      controller.signal,
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(fetchMock).not.toHaveBeenCalled();
});
