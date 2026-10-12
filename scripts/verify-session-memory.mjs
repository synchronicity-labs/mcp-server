import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getHeapStatistics } from 'node:v8';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { hasSessionHeapCapacity } from '../dist/http-server.js';
import { createMcpServerFactory } from '../dist/server.js';
import { SessionRegistry } from '../dist/session-registry.js';

// Local-only: no credentials, upstream requests or paid operations. Optionally
// reproduce against a saved public OpenAPI spec: npm run test:memory -- /path/spec.json.
assert(global.gc, 'Run with --expose-gc');
const burst = process.argv.includes('--burst');
const specPath = process.argv.slice(2).find((arg) => arg !== '--burst');
const spec = specPath
  ? JSON.parse(await readFile(specPath, 'utf8'))
  : {
      openapi: '3.0.0',
      paths: {
        '/v2/projects': {
          post: {
            operationId: 'ProjectsController_create',
            tags: ['projects'],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: Object.fromEntries(
                      Array.from({ length: 40 }, (_, index) => [
                        `field${index}`,
                        {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              label: { type: 'string' },
                              enabled: { type: 'boolean' },
                            },
                          },
                        },
                      ]),
                    ),
                  },
                },
              },
            },
          },
        },
      },
    };
globalThis.fetch = async (url) => {
  assert.equal(String(url), 'https://memory.fixture.invalid/api-json');
  return Response.json(spec);
};
const factory = await createMcpServerFactory({
  baseUrl: 'https://memory.fixture.invalid',
  transport: 'http',
  port: 0,
});
const owner = { sub: 'fixture', clientId: 'fixture', organizationId: null };
let now = 0;
const registry = new SessionRegistry({
  idleTtlMs: 1,
  maxSessions: 1000,
  now: () => now,
  canAdmit: hasSessionHeapCapacity,
});
let clients = [];
// Use the low-level request to avoid counting the SDK client's cached tool-output
// validators as server memory. Real remote clients run in another process.
const list = (client) => client.request({ method: 'tools/list' }, ListToolsResultSchema);
async function initialize(connection) {
  await connection.client.connect(connection.ct);
  const catalog = await list(connection.client);
  if (!specPath)
    assert.equal(
      Object.keys(
        catalog.tools.find((tool) => tool.name === 'projects_create').inputSchema.properties,
      ).length,
      40,
    );
  connection.reservation.commit(connection.id, connection.server, owner).release();
}
function heap() {
  global.gc();
  return process.memoryUsage().heapUsed;
}
const baseline = heap();
try {
  // 120 live, initialized sessions reproduce the production failure range.
  // Includes SDK validators and tools/list JSON conversion, not just constructors.
  for (let index = 0; index < 1001; index++) {
    const reservation = registry.reserve();
    if (!reservation) break;
    const server = factory.createServer();
    const client = new Client({ name: 'chatgpt', version: 'memory-regression' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const connection = { client, server, ct, reservation, id: String(index) };
    clients.push(connection);
    if (!burst) await initialize(connection);
    if (clients.length === 120) {
      const retainedBytes = heap() - baseline;
      console.log(JSON.stringify({ sessions: clients.length, retainedBytes }));
      assert(
        retainedBytes < 128 * 1024 ** 2,
        'Per-session schema duplication exceeded heap budget',
      );
    }
  }
  if (burst) for (const connection of clients) await initialize(connection);
  assert(clients.length >= 120, 'Must support the observed production session count');
  assert.equal(registry.stats().rejected, 1);
  const retained = heap() - baseline;
  if (!specPath)
    assert(retained < 128 * 1024 ** 2, 'Discovery descriptions were duplicated per session');
  assert(hasSessionHeapCapacity(), 'Deferred initialization consumed the request headroom');
  // Existing sessions remain callable when new initialization is refused.
  assert((await list(clients[0].client)).tools.length > 0);
  console.log(
    JSON.stringify({
      burst,
      admitted: clients.length,
      heapUsed: process.memoryUsage().heapUsed,
      heapLimit: getHeapStatistics().heap_size_limit,
      rejected: registry.stats().rejected,
    }),
  );
} finally {
  for (const { client, server, reservation } of clients) {
    await client.close();
    await server.close();
    reservation.release();
  }
  clients = [];
  now = 2;
  await registry.sweep();
  assert.equal(registry.size, 0);
}
await new Promise((resolve) => setImmediate(resolve));
const afterClose = heap();
assert(afterClose - baseline < 20 * 1024 ** 2, 'Closed/expired sessions retained their memory');
const recovered = registry.reserve();
assert(recovered, 'Admission must recover after memory is released');
recovered.release();
console.log(JSON.stringify({ afterClose, baseline, recovery: 'passed' }));
