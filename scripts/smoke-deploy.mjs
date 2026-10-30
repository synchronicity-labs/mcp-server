#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

// Unauthenticated post-deploy smoke check. It waits until /health reports a
// process that started after the deploy began, so an old pod that keeps serving
// while the new one crash-loops does not pass, then checks the OAuth discovery
// documents clients need and that /mcp challenges a request without a token.

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  return res.json();
}

function expectEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export async function waitForNewProcess({
  baseUrl,
  deployStartedAt,
  timeoutMs,
  intervalMs,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const health = await getJson(fetchImpl, new URL('/health', baseUrl));
      last = JSON.stringify(health);
      if (health.status === 'ok' && Date.parse(health.startedAt) >= deployStartedAt) return health;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (now() >= deadline) {
      throw new Error(
        `No server process started after ${new Date(deployStartedAt).toISOString()} within ${timeoutMs / 1000}s (last /health: ${last})`,
      );
    }
    await sleep(intervalMs);
  }
}

export async function checkPublicSurface({ baseUrl, fetchImpl = fetch }) {
  const origin = new URL(baseUrl);
  const issuer = new URL('/', origin).href;
  const resource = await getJson(
    fetchImpl,
    new URL('/.well-known/oauth-protected-resource/mcp', origin),
  );
  expectEqual(resource.resource, new URL('/mcp', origin).href, 'protected resource');
  expectEqual(resource.authorization_servers?.[0], issuer, 'authorization server');
  const server = await getJson(
    fetchImpl,
    new URL('/.well-known/oauth-authorization-server', origin),
  );
  expectEqual(server.issuer, issuer, 'issuer');
  for (const endpoint of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    if (typeof server[endpoint] !== 'string') throw new Error(`issuer metadata lacks ${endpoint}`);
  }
  const res = await fetchImpl(new URL('/mcp', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    signal: AbortSignal.timeout(10_000),
  });
  await res.body?.cancel();
  expectEqual(res.status, 401, 'unauthenticated /mcp status');
  const challenge = res.headers.get('www-authenticate') ?? '';
  if (!challenge.includes('resource_metadata=')) {
    throw new Error(`unauthenticated /mcp challenge lacks resource_metadata: ${challenge}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseUrl = process.env.SMOKE_BASE_URL ?? 'https://mcp.sync.so';
  const deployStartedAt = Date.parse(process.env.DEPLOY_STARTED_AT ?? '');
  if (Number.isNaN(deployStartedAt)) {
    console.error('DEPLOY_STARTED_AT must be an ISO timestamp.');
    process.exit(1);
  }
  try {
    const health = await waitForNewProcess({
      baseUrl,
      deployStartedAt,
      timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS ?? 600_000),
      intervalMs: 10_000,
    });
    await checkPublicSurface({ baseUrl });
    console.log(`Deploy smoke check passed: process started ${health.startedAt}.`);
  } catch (error) {
    console.error(`Deploy smoke check failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
