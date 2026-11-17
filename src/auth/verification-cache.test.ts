import { afterEach, describe, expect, it, vi } from 'vitest';
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

it("forgets only the revoking client's tokens when a client ID is given", async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const token = new Headers(init?.headers).get('authorization')?.slice('Bearer '.length);
    return Response.json({
      ...valid,
      client_id: token?.startsWith('a-') ? 'client-a' : 'client-b',
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const provider = createOAuthProvider('https://fixture.invalid');
  await provider.verifyAccessToken('a-1');
  await provider.verifyAccessToken('b-1');
  provider.clearVerificationCache('client-a');
  await provider.verifyAccessToken('a-1');
  await provider.verifyAccessToken('b-1');
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('does not let a request after a revocation join a check that started before it', async () => {
  let approve!: () => void;
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () => new Promise<Response>((resolve) => (approve = () => resolve(Response.json(valid)))),
    )
    .mockResolvedValueOnce(new Response('', { status: 401 }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = createOAuthProvider('https://fixture.invalid');
  const before = provider.verifyAccessToken('one');
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  provider.clearVerificationCache('client');
  const after = provider.verifyAccessToken('one');
  approve();
  // The caller that was already waiting gets the answer it was waiting for...
  await expect(before).resolves.toMatchObject({ clientId: 'client' });
  // ...but the request made after the revocation checks again and is refused.
  await expect(after).rejects.toMatchObject({ errorCode: 'invalid_token' });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  // The early answer was not cached either.
  await expect(provider.verifyAccessToken('one')).rejects.toBeTruthy();
});

it('keeps counting checks a revocation detached, and stops them when their caller leaves', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signals.push(init!.signal!);
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ),
  );
  const provider = createOAuthProvider('https://fixture.invalid');
  const callers = Array.from({ length: 128 }, (_, i) => {
    const controller = new AbortController();
    const result = provider.verifyAccessToken(`held-${i}`, controller.signal).catch((e) => e);
    return { controller, result };
  });
  await vi.waitFor(() => expect(signals).toHaveLength(128));
  provider.clearVerificationCache('client');
  // Detached checks still run, so the limit still holds.
  await expect(provider.verifyAccessToken('one-more')).rejects.toMatchObject({ status: 503 });
  // A detached check stops when its only caller goes away, freeing its place.
  callers[0]!.controller.abort();
  await callers[0]!.result;
  expect(signals[0]!.aborted).toBe(true);
  await vi.waitFor(async () => {
    const next = provider.verifyAccessToken('after-free', AbortSignal.timeout(50));
    await expect(next).rejects.toMatchObject({ status: 503 });
    expect(signals).toHaveLength(129);
  });
  for (const caller of callers) caller.controller.abort();
  await Promise.all(callers.map((caller) => caller.result));
});

describe('audience', () => {
  const server = createOAuthProvider('https://fixture.invalid', undefined, {
    audiences: ['https://mcp.sync.so/mcp', 'https://mcp.sync.so'],
  });

  it.each([
    ['no audience (the API today)', undefined],
    ['this server', 'https://mcp.sync.so/mcp'],
    ['this server with a trailing slash', 'https://mcp.sync.so/mcp/'],
    ['this server by origin', 'https://mcp.sync.so'],
    ['a list that names this server', ['https://api.sync.so', 'https://mcp.sync.so/mcp']],
  ])('accepts a token for %s', async (_label, aud) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...valid, aud })),
    );
    await expect(server.verifyAccessToken(`token-${JSON.stringify(aud)}`)).resolves.toMatchObject({
      clientId: 'client',
    });
  });

  it.each([
    ['another resource', 'https://api.sync.so'],
    ['a look-alike host', 'https://mcp.sync.so.evil.example/mcp'],
    ['an empty list', []],
    ['not a URL', 'mcp'],
    ['this server with a query', 'https://mcp.sync.so/mcp?resource=other'],
    ['this server with a fragment', 'https://mcp.sync.so/mcp#other'],
  ])('refuses a token for %s', async (_label, aud) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...valid, aud })),
    );
    await expect(server.verifyAccessToken(`token-${JSON.stringify(aud)}`)).rejects.toMatchObject({
      errorCode: 'invalid_token',
    });
  });

  it('checks nothing when no audience is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...valid, aud: 'https://other' })),
    );
    await expect(
      createOAuthProvider('https://fixture.invalid').verifyAccessToken('any'),
    ).resolves.toBeTruthy();
  });
});
