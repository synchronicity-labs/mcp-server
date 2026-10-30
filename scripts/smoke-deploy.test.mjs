import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPublicSurface, waitForNewProcess } from './smoke-deploy.mjs';

const baseUrl = 'https://mcp.example.test';
const deployStartedAt = Date.parse('2026-10-30T20:00:00.000Z');

function healthSequence(startedAts) {
  let call = 0;
  return async () => {
    const startedAt = startedAts[Math.min(call++, startedAts.length - 1)];
    return Response.json({ status: 'ok', startedAt });
  };
}

void test('waits past the old process until one started after the deploy answers', async () => {
  let clock = deployStartedAt;
  const health = await waitForNewProcess({
    baseUrl,
    deployStartedAt,
    timeoutMs: 60_000,
    intervalMs: 10_000,
    fetchImpl: healthSequence([
      '2026-10-30T18:46:00.000Z',
      '2026-10-30T18:46:00.000Z',
      '2026-10-30T20:00:31.000Z',
    ]),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(health.startedAt, '2026-10-30T20:00:31.000Z');
});

void test('fails with the last /health answer when the new process never serves', async () => {
  let clock = deployStartedAt;
  await assert.rejects(
    waitForNewProcess({
      baseUrl,
      deployStartedAt,
      timeoutMs: 30_000,
      intervalMs: 10_000,
      fetchImpl: healthSequence(['2026-10-30T18:46:00.000Z']),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }),
    /No server process started after 2026-10-30T20:00:00\.000Z within 30s .*18:46:00/,
  );
});

function publicSurface({ challenge = 'Bearer resource_metadata="x"', status = 401 } = {}) {
  return async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/.well-known/oauth-protected-resource/mcp')
      return Response.json({
        resource: `${baseUrl}/mcp`,
        authorization_servers: [`${baseUrl}/`],
      });
    if (pathname === '/.well-known/oauth-authorization-server')
      return Response.json({
        issuer: `${baseUrl}/`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      });
    if (pathname === '/mcp')
      return new Response('{}', { status, headers: { 'www-authenticate': challenge } });
    return new Response('not found', { status: 404 });
  };
}

void test('accepts the OAuth discovery documents and the unauthenticated challenge', async () => {
  await checkPublicSurface({ baseUrl, fetchImpl: publicSurface() });
});

void test('rejects an /mcp endpoint that no longer challenges unauthenticated requests', async () => {
  await assert.rejects(
    checkPublicSurface({ baseUrl, fetchImpl: publicSurface({ status: 200 }) }),
    /unauthenticated \/mcp status: expected 401, got 200/,
  );
  await assert.rejects(
    checkPublicSurface({ baseUrl, fetchImpl: publicSurface({ challenge: 'Bearer' }) }),
    /lacks resource_metadata/,
  );
});
