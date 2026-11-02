import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPublicSurface, deployStartFrom, waitForNewProcess } from './smoke-deploy.mjs';

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
