import { afterEach, expect, it, vi } from 'vitest';
import { createOAuthProvider } from './oauth-provider.js';
import { VERIFICATION_CACHE_MS } from './verification-cache.js';

const valid = { sub: 'user', client_id: 'client', expires_at: 4000000000 };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('collapses a 108-request burst, isolates tokens, and rechecks after fifteen seconds', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => Response.json(valid));
  vi.stubGlobal('fetch', fetchMock);
  const provider = createOAuthProvider('https://fixture.invalid');
  const results = await Promise.all(
    Array.from({ length: 108 }, () => provider.verifyAccessToken('one')),
  );
  expect(results).toHaveLength(108);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  results[0]!.extra!.sub = 'modified';
  expect((await provider.verifyAccessToken('one')).extra?.sub).toBe('user');
  await provider.verifyAccessToken('two');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(VERIFICATION_CACHE_MS);
  await provider.verifyAccessToken('one');
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('never serves stale verification after token expiry or a failed refresh', async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ ...valid, expires_at: Math.floor(Date.now() / 1000) + 1 }),
    )
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(new Response('', { status: 401 }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = createOAuthProvider('https://fixture.invalid');
  await provider.verifyAccessToken('one');
  await vi.advanceTimersByTimeAsync(1000);
  await expect(provider.verifyAccessToken('one')).rejects.toMatchObject({ status: 503 });
  await expect(provider.verifyAccessToken('one')).rejects.toMatchObject({
    errorCode: 'invalid_token',
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('clears verified tokens following revocation and bounds the successful cache', async () => {
  const fetchMock = vi.fn(async () => Response.json(valid));
  vi.stubGlobal('fetch', fetchMock);
  const provider = createOAuthProvider('https://fixture.invalid');
  await provider.verifyAccessToken('one');
  provider.clearVerificationCache();
  await provider.verifyAccessToken('one');
  for (let i = 0; i < 512; i++) await provider.verifyAccessToken(`other-${i}`);
  await provider.verifyAccessToken('one');
  expect(fetchMock).toHaveBeenCalledTimes(515);
});

it('isolates rate-limited tokens and caps extreme upstream retry deadlines', async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '86400' } }))
    .mockImplementation(async () => Response.json(valid));
  vi.stubGlobal('fetch', fetchMock);
  const provider = createOAuthProvider('https://fixture.invalid');
  await expect(provider.verifyAccessToken('limited')).rejects.toMatchObject({ status: 429 });
  await expect(provider.verifyAccessToken('limited')).rejects.toMatchObject({
    status: 429,
    retryAfter: '15',
  });
  await expect(provider.verifyAccessToken('unrelated')).resolves.toMatchObject({
    extra: { sub: 'user' },
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(15000);
  await provider.verifyAccessToken('limited');
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('cancels individual waiters independently and aborts upstream when none remain', async () => {
  let upstreamSignal: AbortSignal | undefined;
  let complete!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, init) => {
      upstreamSignal = init.signal;
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    }),
  );
  const provider = createOAuthProvider('https://fixture.invalid');
  const controller = new AbortController();
  const first = provider.verifyAccessToken('one', controller.signal);
  const assertion = expect(first).rejects.toMatchObject({ status: 503 });
  const second = provider.verifyAccessToken('one');
  controller.abort();
  await assertion;
  expect(upstreamSignal?.aborted).toBe(false);
  complete(Response.json(valid));
  await expect(second).resolves.toMatchObject({ token: 'one' });
  const lastController = new AbortController();
  const last = provider.verifyAccessToken('two', lastController.signal);
  const lastAssertion = expect(last).rejects.toMatchObject({ status: 503 });
  lastController.abort();
  await lastAssertion;
  expect(upstreamSignal?.aborted).toBe(true);
});
