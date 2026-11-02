import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import express from 'express';
import { resolveConfig } from '../dist/config.js';
import { createSessionHeapAdmission, getSessionRuntimeConfig } from '../dist/http-server.js';
import { HttpSession } from '../dist/http-session.js';
import { createMcpServerFactory } from '../dist/server.js';
import { SessionRegistry } from '../dist/session-registry.js';

// No credentials, external requests or paid tools. Use the actual packaged HTML
// and HTTP adapter: InMemoryTransport cannot detect retained JSON Responses.
assert(global.gc, 'Run with --expose-gc');
const fetchHttp = globalThis.fetch;
globalThis.fetch = async (url) => {
  const href = url instanceof URL ? url.href : url instanceof Request ? url.url : url;
  assert.equal(href, 'https://memory.fixture.invalid/api-json');
  return Response.json({ openapi: '3.0.0', paths: {} });
};
const root = resolve('chatgpt-dist');
const catalog = JSON.parse(await readFile(resolve(root, 'releases.json'), 'utf8'));
const releases = [catalog.current, ...catalog.previous];
process.env.SYNC_CHATGPT_APP_RELEASES = resolve(root, 'releases.json');
process.env.SYNC_CHATGPT_APP_DOMAIN = 'https://memory.fixture.invalid';
const factory = await createMcpServerFactory(
  resolveConfig({ baseUrl: 'https://memory.fixture.invalid', transport: 'http', port: 0 }),
);
const soakMinutes = Number(
  process.argv.find((arg) => arg.startsWith('--soak-minutes='))?.split('=')[1] ?? 0,
);
assert(Number.isFinite(soakMinutes) && soakMinutes >= 0 && soakMinutes <= 120);
let now = 0;
const owner = { sub: 'memory-fixture', clientId: 'memory-fixture', organizationId: null };
const sessionConfig = getSessionRuntimeConfig({});
const sessions = new SessionRegistry({
  idleTtlMs: sessionConfig.idleTtlMs,
  maxSessions: sessionConfig.maxSessions,
  canAdmit: createSessionHeapAdmission(),
  now: () => (soakMinutes ? Date.now() : now),
});
const app = express();
app.use(express.json());
app.all('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let lease;
  let reservation;
  let transport;
  try {
    if (sessionId) {
      lease = sessions.acquire(sessionId, owner);
      if (!lease) return void res.status(404).end();
      transport = lease.transport;
    } else {
      reservation = sessions.reserve();
      if (!reservation) return void res.status(503).end();
      transport = new HttpSession(req.body.params.clientInfo.name, factory.createServer, () => {});
      const id = randomUUID();
      lease = reservation.commit(id, transport, owner);
      res.setHeader('Mcp-Session-Id', id);
    }
    if (req.method === 'DELETE') {
      await sessions.remove(sessionId, 'closed');
      return void res.status(200).end();
    }
    await transport.handleRequest(req, res, !sessionId);
  } finally {
    lease?.release();
    reservation?.release();
  }
});
const listener = app.listen(0, '127.0.0.1');
await new Promise((done) => listener.once('listening', done));
const url = `http://127.0.0.1:${listener.address().port}/mcp`;
let requestId = 0;
async function post(sessionId, method, params) {
  return fetchHttp(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(method.startsWith('notifications/') ? {} : { id: ++requestId }),
      method,
      params,
    }),
    signal: AbortSignal.timeout(10_000),
  });
}
async function initialize() {
  const response = await post(undefined, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'chatgpt', version: 'http-memory-regression' },
  });
  assert.equal(response.status, 200);
  const sessionId = response.headers.get('mcp-session-id');
  assert(sessionId);
  assert((await response.json()).result);
  const initialized = await post(sessionId, 'notifications/initialized');
  assert.equal(initialized.status, 202);
  await initialized.text();
  const tools = await post(sessionId, 'tools/list');
  assert((await tools.json()).result.tools.some((tool) => tool.name === 'open-sync-app'));
  return sessionId;
}
async function readResource(sessionId, digest) {
  const uri = `ui://sync/app-${digest}.html`;
  const response = await post(sessionId, 'resources/read', { uri });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();
  assert.equal(body.result.contents[0].uri, uri);
  assert.equal(createHash('sha256').update(body.result.contents[0].text).digest('hex'), digest);
}
async function heap() {
  await new Promise((done) => setImmediate(done));
  global.gc();
  return process.memoryUsage().heapUsed;
}
try {
  // Warm shared descriptors and HTTP machinery before measuring retained growth.
  const warmSession = await initialize();
  await readResource(warmSession, catalog.current);
  if (soakMinutes) {
    await sessions.closeAll();
    const reused = await Promise.all(Array.from({ length: 8 }, () => initialize()));
    const baseline = await heap();
    const started = Date.now();
    let nextSample = started;
    let iterations = 0;
    const samples = [];
    while (Date.now() - started < soakMinutes * 60_000) {
      const scheduled = Date.now();
      const fresh = await initialize();
      for (const id of [fresh, reused[iterations % reused.length]]) {
        const response = await post(id, 'tools/call', { name: 'open-sync-app', arguments: {} });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert(result.result && !result.result.isError);
      }
      if (iterations % 160 === 0) await readResource(reused[0], catalog.current);
      await sessions.sweep();
      assert(sessions.size < 365 + reused.length);
      assert.equal(sessions.stats().rejected, 0);
      if (Date.now() >= nextSample) {
        const growth = (await heap()) - baseline;
        samples.push(growth);
        assert(growth < 64 * 1024 ** 2, 'Request-scoped SDK graphs retained excessive heap');
        console.log(
          JSON.stringify({
            scenario: 'wall-clock-mixed-traffic',
            elapsedMs: Date.now() - started,
            iterations,
            heapGrowth: growth,
            sessions: sessions.stats(),
          }),
        );
        nextSample = Date.now() + 60_000;
      }
      iterations++;
      await new Promise((done) => setTimeout(done, Math.max(0, 375 - (Date.now() - scheduled))));
    }
    const steady = samples.slice(3);
    if (steady.length > 2)
      assert(
        Math.max(...steady) - Math.min(...steady) < 32 * 1024 ** 2,
        'Steady-state heap did not plateau',
      );
    await sessions.closeAll();
    assert.equal(sessions.size, 0);
    assert((await heap()) - baseline < 32 * 1024 ** 2);
    console.log(
      JSON.stringify({
        scenario: 'wall-clock-mixed-traffic-complete',
        elapsedMs: Date.now() - started,
        iterations,
        sessions: sessions.stats(),
      }),
    );
  } else {
    now += 120_001;
    assert.equal(await sessions.sweep(), 1);
    const baseline = await heap();
    for (let cycle = 1; cycle <= 3; cycle++) {
      const clients = await Promise.all([initialize(), initialize()]);
      for (const digest of [...releases, ...Array.from({ length: 4 }, () => catalog.current)]) {
        await Promise.all(clients.map((sessionId) => readResource(sessionId, digest)));
      }
      assert.equal(sessions.size, 2);
      const liveGrowth = (await heap()) - baseline;
      assert(liveGrowth < 32 * 1024 ** 2, `Completed HTTP responses retained ${liveGrowth} bytes`);
      now += 120_001;
      assert.equal(await sessions.sweep(), 2);
      assert.equal(sessions.size, 0);
      const expired = await post(clients[0], 'tools/list');
      assert.equal(expired.status, 404);
      await expired.text();
      const closedGrowth = (await heap()) - baseline;
      assert(closedGrowth < 20 * 1024 ** 2, `Expired HTTP sessions retained ${closedGrowth} bytes`);
      assert.equal(sessions.stats().rejected, 0);
      console.log(JSON.stringify({ cycle, liveGrowth, closedGrowth, sessions: sessions.stats() }));
    }
    // Model 45 minutes at 160 fresh sessions/minute (5x incident traffic), with
    // real HTTP initialization/discovery and no client DELETE. Virtual time keeps
    // this regression practical in CI; it is not a wall-clock production soak.
    let peakHeapGrowth = 0;
    for (let index = 0; index < 7200; index++) {
      await initialize();
      now += 375;
      if (index % 40 === 0) await sessions.sweep();
      assert(sessions.size < 365, 'Idle sessions accumulated beyond the retention window');
      if (index % 400 === 0) {
        peakHeapGrowth = Math.max(peakHeapGrowth, (await heap()) - baseline);
        assert(peakHeapGrowth < 128 * 1024 ** 2, 'Session churn retained excessive heap');
      }
    }
    assert.equal(sessions.stats().rejected, 0);
    now += 120_001;
    await sessions.sweep();
    assert.equal(sessions.size, 0);
    assert((await heap()) - baseline < 32 * 1024 ** 2, 'Churn left retained sessions');
    console.log(
      JSON.stringify({
        scenario: '45-minute-session-churn',
        peakHeapGrowth,
        sessions: sessions.stats(),
      }),
    );
  }
} finally {
  await sessions.closeAll();
  listener.closeAllConnections();
  await new Promise((done) => listener.close(done));
}
