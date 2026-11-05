import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AttemptLog,
  backoffDelay,
  checkPublicSurface,
  connectivityDiagnostic,
  deployStartFrom,
  describeFetchError,
  waitForNewProcess,
} from './smoke-deploy.mjs';

const baseUrl = 'https://mcp.example.test';
const deployStartedAt = Date.parse('2026-10-30T20:00:00.000Z');

function healthSequence(answers) {
  let call = 0;
  return async () =>
    Response.json({ status: 'ok', ...answers[Math.min(call++, answers.length - 1)] });
}

function fakeClock() {
  let clock = deployStartedAt;
  return {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
}

void test('waits past the old process until the deployed revision answers', async () => {
  const health = await waitForNewProcess({
    baseUrl,
    deployStartedAt,
    expectedRevision: 'new',
    timeoutMs: 60_000,
    intervalMs: 10_000,
    fetchImpl: healthSequence([
      { revision: 'old', startedAt: '2026-10-30T18:46:00.000Z' },
      { revision: 'new', startedAt: '2026-10-30T20:00:31.000Z' },
    ]),
    ...fakeClock(),
  });
  assert.equal(health.revision, 'new');
});

void test('does not accept an old revision that restarted during the rollout', async () => {
  await assert.rejects(
    waitForNewProcess({
      baseUrl,
      deployStartedAt,
      expectedRevision: 'new',
      timeoutMs: 30_000,
      intervalMs: 10_000,
      fetchImpl: healthSequence([{ revision: 'old', startedAt: '2026-10-30T20:00:05.000Z' }]),
      ...fakeClock(),
    }),
    /No revision new server process started after 2026-10-30T20:00:00\.000Z within 30s .*"old"/,
  );
});

void test('fails with the last /health answer when no new process serves', async () => {
  await assert.rejects(
    waitForNewProcess({
      baseUrl,
      deployStartedAt,
      timeoutMs: 30_000,
      intervalMs: 10_000,
      fetchImpl: healthSequence([{ startedAt: '2026-10-30T18:46:00.000Z' }]),
      ...fakeClock(),
    }),
    /No server process started after 2026-10-30T20:00:00\.000Z within 30s .*18:46:00/,
  );
});

const goodDiscovery = {
  resource: { resource: `${baseUrl}/mcp`, authorization_servers: [`${baseUrl}/`] },
  server: {
    issuer: `${baseUrl}/`,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
  },
  status: 401,
  challenge: `Bearer error="invalid_token", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
};

function publicSurface(overrides = {}) {
  const surface = { ...goodDiscovery, ...overrides };
  return async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/.well-known/oauth-protected-resource/mcp')
      return Response.json(surface.resource);
    if (pathname === '/.well-known/oauth-authorization-server')
      return Response.json(surface.server);
    if (pathname === '/mcp')
      return new Response('{}', {
        status: surface.status,
        headers: { 'www-authenticate': surface.challenge },
      });
    return new Response('not found', { status: 404 });
  };
}

void test('accepts the expected discovery documents and unauthenticated challenge', async () => {
  await checkPublicSurface({ baseUrl, fetchImpl: publicSurface() });
});

void test('rejects discovery URLs that point anywhere else or are malformed', async () => {
  await assert.rejects(
    checkPublicSurface({
      baseUrl,
      fetchImpl: publicSurface({
        server: { ...goodDiscovery.server, token_endpoint: 'https://evil.example/token' },
      }),
    }),
    /token_endpoint: expected "https:\/\/mcp\.example\.test\/token"/,
  );
  await assert.rejects(
    checkPublicSurface({
      baseUrl,
      fetchImpl: publicSurface({ server: { ...goodDiscovery.server, authorization_endpoint: '' } }),
    }),
    /authorization_endpoint/,
  );
  await assert.rejects(
    checkPublicSurface({
      baseUrl,
      fetchImpl: publicSurface({
        resource: { ...goodDiscovery.resource, resource: 'not a url' },
      }),
    }),
    /protected resource/,
  );
});

void test('rejects an /mcp endpoint that stops challenging or points at the wrong metadata', async () => {
  await assert.rejects(
    checkPublicSurface({ baseUrl, fetchImpl: publicSurface({ status: 200 }) }),
    /unauthenticated \/mcp status: expected 401, got 200/,
  );
  await assert.rejects(
    checkPublicSurface({
      baseUrl,
      fetchImpl: publicSurface({ challenge: 'Bearer resource_metadata="x"' }),
    }),
    /resource_metadata: expected/,
  );
  await assert.rejects(
    checkPublicSurface({ baseUrl, fetchImpl: publicSurface({ challenge: 'Bearer' }) }),
    /resource_metadata: expected/,
  );
});

void test('requires a deploy start unless the run checks the process already serving', () => {
  assert.equal(
    deployStartFrom({ deployStartedAt: '2026-10-30T20:00:00.000Z', allowExisting: false }),
    deployStartedAt,
  );
  assert.equal(deployStartFrom({ deployStartedAt: '', allowExisting: true }), 0);
  assert.throws(() => deployStartFrom({ deployStartedAt: '', allowExisting: false }), /ISO/);
  assert.throws(() => deployStartFrom({ deployStartedAt: 'soon', allowExisting: false }), /ISO/);
});

/** What undici throws when it never gets a response: TypeError('fetch failed') with the cause. */
function fetchFailed(code, message) {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
}

function recordingClock() {
  const clock = fakeClock();
  const sleeps = [];
  return {
    sleeps,
    now: clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      await clock.sleep(ms);
    },
  };
}

void test('names the cause undici hides behind "fetch failed"', () => {
  for (const [code, message] of [
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND mcp.sync.so'],
    ['ECONNREFUSED', 'connect ECONNREFUSED 203.0.113.7:443'],
    ['ECONNRESET', 'read ECONNRESET'],
    ['UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error (attempted address: mcp.sync.so:443)'],
    ['CERT_HAS_EXPIRED', 'certificate has expired'],
  ]) {
    assert.equal(describeFetchError(fetchFailed(code, message)), `${code}: ${message}`);
  }
  // Happy eyeballs: Node's net module rejects with an AggregateError that has a code but
  // no message, and one error per address.
  const perAddress = {
    name: 'AggregateError',
    code: 'ETIMEDOUT',
    message: '',
    errors: [
      Object.assign(new Error('connect ETIMEDOUT 203.0.113.7:443'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('connect ENETUNREACH 2001:db8::1:443'), { code: 'ENETUNREACH' }),
    ],
  };
  assert.equal(
    describeFetchError(new TypeError('fetch failed', { cause: perAddress })),
    'ETIMEDOUT: connect ETIMEDOUT 203.0.113.7:443, connect ENETUNREACH 2001:db8::1:443',
  );
  const nested = new TypeError('fetch failed', {
    cause: new Error('wrapper', {
      cause: Object.assign(new Error('socket hang up'), { code: 'UND_ERR_SOCKET' }),
    }),
  });
  assert.equal(describeFetchError(nested), 'UND_ERR_SOCKET: socket hang up');
  assert.equal(
    describeFetchError(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    ),
    'TimeoutError: The operation was aborted due to timeout',
  );
  assert.equal(describeFetchError(new TypeError('fetch failed')), 'TypeError: fetch failed');
  assert.equal(describeFetchError('boom'), 'boom');
});

void test('summarizes the last few distinct errors with counts and first and last times', () => {
  const log = new AttemptLog();
  const at = (time) => Date.parse(`2026-11-05T${time}.000Z`);
  log.record('ENOTFOUND: getaddrinfo ENOTFOUND mcp.sync.so', at('12:07:10'), { responded: false });
  log.record('ECONNREFUSED', at('12:08:14'), { responded: false });
  log.record('HTTP 502 Bad Gateway', at('12:09:00'), { responded: true });
  log.record('ECONNREFUSED', at('12:18:15'), { responded: false });
  log.record('revision "old" serving, started x', at('12:18:25'), { responded: true });
  assert.equal(log.attempts, 5);
  assert.equal(log.responded, true);
  assert.equal(
    log.summary(),
    '1 earlier distinct error; HTTP 502 Bad Gateway ×1 (12:09:00); ECONNREFUSED ×2 (12:08:14–12:18:15); revision "old" serving, started x ×1 (12:18:25)',
  );
  assert.equal(
    log.summary(10).split('; ')[0],
    'ENOTFOUND: getaddrinfo ENOTFOUND mcp.sync.so ×1 (12:07:10)',
  );
});

void test('backs off from the first delay, doubling up to the cap', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((retry) => backoffDelay(retry, { initialMs: 1_000, maxMs: 10_000 })),
    [1_000, 2_000, 4_000, 8_000, 10_000, 10_000],
  );
});

void test('reports why /health never answered when every fetch throws', async () => {
  const clock = recordingClock();
  const error = await waitForNewProcess({
    baseUrl,
    deployStartedAt,
    expectedRevision: 'new',
    timeoutMs: 30_000,
    intervalMs: 10_000,
    fetchImpl: async () => {
      throw fetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 203.0.113.7:443');
    },
    ...clock,
  }).catch((caught) => caught);
  assert.match(
    error.message,
    /^No revision new server process started after 2026-10-30T20:00:00\.000Z within 30s \(7 attempts; last \/health errors: ECONNREFUSED: connect ECONNREFUSED 203\.0\.113\.7:443 ×7 \(20:00:00–20:00:30\)\)$/,
  );
  assert.equal(error.responded, false);
  // 1+2+4+8+10 = 25s, then the last sleep stops at the deadline for one final try.
  assert.deepEqual(clock.sleeps, [1_000, 2_000, 4_000, 8_000, 10_000, 5_000]);
});

void test('reports non-2xx /health answers with their status', async () => {
  const error = await waitForNewProcess({
    baseUrl,
    deployStartedAt,
    expectedRevision: 'new',
    timeoutMs: 30_000,
    intervalMs: 10_000,
    fetchImpl: async () => new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' }),
    ...fakeClock(),
  }).catch((caught) => caught);
  assert.match(error.message, /last \/health errors: HTTP 502 Bad Gateway ×7 /);
  assert.equal(error.responded, true);
});

void test('passes once /health recovers from network errors and non-2xx answers', async () => {
  const answers = [
    () => {
      throw fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND mcp.example.test');
    },
    () => new Response('', { status: 503 }),
    () => Response.json({ status: 'ok', revision: 'new', startedAt: '2026-10-30T20:00:31.000Z' }),
  ];
  let call = 0;
  const notices = [];
  const health = await waitForNewProcess({
    baseUrl,
    deployStartedAt,
    expectedRevision: 'new',
    timeoutMs: 60_000,
    intervalMs: 10_000,
    fetchImpl: async () => answers[call++](),
    notice: (message) => notices.push(message),
    ...fakeClock(),
  });
  assert.equal(health.revision, 'new');
  assert.equal(call, 3);
  assert.match(
    notices[0],
    /^\/health succeeded on attempt 3 \(earlier: ENOTFOUND: .* ×1 .*; HTTP 503 ×1 /,
  );
});

void test('tells a revision that is serving but not the deployed one from one that never answered', async () => {
  const error = await waitForNewProcess({
    baseUrl,
    deployStartedAt,
    expectedRevision: 'new',
    timeoutMs: 10_000,
    intervalMs: 10_000,
    fetchImpl: healthSequence([{ revision: 'old', startedAt: '2026-10-30T18:46:00.000Z' }]),
    ...fakeClock(),
  }).catch((caught) => caught);
  assert.match(error.message, /revision "old" serving, started 2026-10-30T18:46:00\.000Z ×\d/);
  assert.equal(error.responded, true);
});

void test('retries a discovery or /mcp blip and still passes', async () => {
  const good = publicSurface();
  const blips = new Map([
    [
      '/.well-known/oauth-protected-resource/mcp',
      [() => Promise.reject(fetchFailed('ECONNRESET', 'read ECONNRESET'))],
    ],
    ['/mcp', [() => new Response('', { status: 502 }), () => new Response('', { status: 429 })]],
  ]);
  const calls = [];
  const notices = [];
  await checkPublicSurface({
    baseUrl,
    fetchImpl: async (url, init) => {
      const { pathname } = new URL(url);
      calls.push(pathname);
      const blip = blips.get(pathname)?.shift();
      return blip ? blip() : good(url, init);
    },
    deadline: deployStartedAt + 60_000,
    notice: (message) => notices.push(message),
    ...fakeClock(),
  });
  assert.deepEqual(calls, [
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/mcp',
    '/mcp',
    '/mcp',
  ]);
  assert.equal(notices.length, 2);
});

void test('fails a discovery step that keeps erroring, with its errors', async () => {
  const good = publicSurface();
  await assert.rejects(
    checkPublicSurface({
      baseUrl,
      fetchImpl: async (url, init) =>
        new URL(url).pathname === '/.well-known/oauth-authorization-server'
          ? new Response('', { status: 503, statusText: 'Service Unavailable' })
          : good(url, init),
      deadline: deployStartedAt + 20_000,
      ...fakeClock(),
    }),
    /last GET \/\.well-known\/oauth-authorization-server errors: HTTP 503 Service Unavailable ×\d+ /,
  );
});

void test('gives a step that starts past the deadline three tries', async () => {
  let calls = 0;
  const clock = recordingClock();
  await assert.rejects(
    checkPublicSurface({
      baseUrl,
      fetchImpl: async () => {
        calls++;
        throw fetchFailed('ECONNRESET', 'read ECONNRESET');
      },
      deadline: deployStartedAt - 1,
      ...clock,
    }),
    /\(3 attempts; last GET \/\.well-known\/oauth-protected-resource\/mcp errors: ECONNRESET: read ECONNRESET ×3 /,
  );
  assert.equal(calls, 3);
});

void test('does not retry a wrong answer', async () => {
  let calls = 0;
  const bad = publicSurface({ status: 200 });
  await assert.rejects(
    checkPublicSurface({
      baseUrl,
      fetchImpl: async (url, init) => {
        calls++;
        return bad(url, init);
      },
      deadline: deployStartedAt + 60_000,
      ...fakeClock(),
    }),
    /unauthenticated \/mcp status: expected 401, got 200/,
  );
  assert.equal(calls, 3);
});

void test('the connectivity diagnostic prints what the host resolves to, or why it does not', async () => {
  assert.equal(
    await connectivityDiagnostic('mcp.sync.so', {
      lookupImpl: async (hostname, options) => {
        assert.equal(hostname, 'mcp.sync.so');
        assert.deepEqual(options, { all: true });
        return [
          { address: '203.0.113.7', family: 4 },
          { address: '2001:db8::1', family: 6 },
        ];
      },
    }),
    'DNS lookup mcp.sync.so: 203.0.113.7 (IPv4), 2001:db8::1 (IPv6)',
  );
  assert.equal(
    await connectivityDiagnostic('mcp.sync.so', {
      lookupImpl: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND mcp.sync.so'), { code: 'ENOTFOUND' });
      },
    }),
    'DNS lookup mcp.sync.so failed: ENOTFOUND: getaddrinfo ENOTFOUND mcp.sync.so',
  );
  assert.equal(
    await connectivityDiagnostic('mcp.sync.so', {
      lookupImpl: () => new Promise(() => {}),
      timeoutMs: 5,
    }),
    'DNS lookup mcp.sync.so failed: no answer within 0.005s',
  );
});

/** A response whose body stream has already failed, as after a reset mid-body. */
function brokenBody(status, statusText) {
  const body = new ReadableStream({
    pull(controller) {
      controller.error(
        new TypeError('terminated', {
          cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
        }),
      );
    },
  });
  const res = new Response(body, { status, statusText });
  // cancel() on an errored stream rejects; make sure the check does not depend on that.
  body.cancel = () => Promise.reject(new TypeError('Invalid state: ReadableStream is errored'));
  return res;
}

void test('keeps retrying when discarding a non-2xx body fails', async () => {
  const good = publicSurface();
  const blips = new Map([
    ['/.well-known/oauth-authorization-server', [() => brokenBody(502, 'Bad Gateway')]],
    ['/mcp', [() => brokenBody(503, 'Service Unavailable')]],
  ]);
  const notices = [];
  await checkPublicSurface({
    baseUrl,
    fetchImpl: async (url, init) => {
      const blip = blips.get(new URL(url).pathname)?.shift();
      return blip ? blip() : good(url, init);
    },
    deadline: deployStartedAt + 60_000,
    notice: (message) => notices.push(message),
    ...fakeClock(),
  });
  assert.match(notices[0], /HTTP 502 Bad Gateway ×1/);
  assert.match(notices[1], /HTTP 503 Service Unavailable ×1/);
});

void test('retries a body that breaks off mid-read', async () => {
  const good = publicSurface();
  let broke = false;
  await checkPublicSurface({
    baseUrl,
    fetchImpl: async (url, init) => {
      if (!broke) {
        broke = true;
        return brokenBody(200);
      }
      return good(url, init);
    },
    deadline: deployStartedAt + 60_000,
    ...fakeClock(),
  });
  assert.equal(broke, true);
});

void test('fails a discovery document that is not JSON at once, but waits out one on /health', async () => {
  let calls = 0;
  const html = () =>
    new Response('<html>default backend</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(
    checkPublicSurface({
      baseUrl,
      fetchImpl: async () => {
        calls++;
        return html();
      },
      deadline: deployStartedAt + 60_000,
      ...fakeClock(),
    }),
    /^Error: GET \/\.well-known\/oauth-protected-resource\/mcp returned invalid JSON \(content-type "text\/html"\): /,
  );
  assert.equal(calls, 1);
  const answers = [
    html,
    () => Response.json({ status: 'ok', revision: 'new', startedAt: '2026-10-30T20:00:31.000Z' }),
  ];
  let call = 0;
  const health = await waitForNewProcess({
    baseUrl,
    deployStartedAt,
    expectedRevision: 'new',
    timeoutMs: 60_000,
    intervalMs: 10_000,
    fetchImpl: async () => answers[call++](),
    ...fakeClock(),
  });
  assert.equal(health.revision, 'new');
});
