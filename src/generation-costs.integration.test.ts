import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';

const generationId = '00000000-0000-4000-8000-000000000abc';
const requests: Array<{ method?: string; path?: string; auth?: string }> = [];
const component = {
  type: 'lipsync',
  operationId: generationId,
  status: 'recorded',
  amountUsd: '0.32000',
  credits: '32',
  valueBasis: 'credit_face_value',
  quantity: 60,
  unit: 'frames',
  unitRateUsd: null,
  source: 'credit_ledger',
  reason: null,
};
const receipt = {
  generationId,
  generationStatus: 'COMPLETED',
  currency: 'USD',
  availability: 'complete',
  totalCostUsd: '0.48000',
  knownSubtotalUsd: '0.48000',
  retryAfterSeconds: null,
  components: [
    component,
    {
      ...component,
      type: 'dubbing',
      operationId: '00000000-0000-4000-8000-000000000def',
      amountUsd: '0.16000',
      credits: '16',
      quantity: 10,
      unit: 'seconds',
    },
  ],
  excludedCosts: ['tax', 'subscription_fees', 'external_provider_charges'],
};
const upstream = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url?.endsWith('/api-json')) {
    res.end(
      JSON.stringify({
        openapi: '3.0.0',
        paths: req.url.startsWith('/old/')
          ? {}
          : {
              '/v2/generate/{id}/costs': {
                get: {
                  operationId: 'GenerateController_getGenerationCosts',
                  tags: ['Generate'],
                  parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                  ],
                  responses: {
                    '200': {
                      description: 'Recorded costs',
                      content: { 'application/json': { schema: { type: 'object' } } },
                    },
                  },
                },
              },
            },
      }),
    );
    return;
  }
  requests.push({ method: req.method, path: req.url, auth: req.headers.authorization });
  if (req.headers.authorization === 'Bearer unauthorized') {
    res.writeHead(401).end(JSON.stringify({ message: 'Reconnect your account' }));
  } else if (req.headers.authorization === 'Bearer outage') {
    res.writeHead(503).end(JSON.stringify({ message: 'Usage unavailable' }));
  } else if (req.headers.authorization === 'Bearer partial') {
    res.end(
      JSON.stringify({
        ...receipt,
        availability: 'partial',
        totalCostUsd: null,
        knownSubtotalUsd: '0.16000',
        components: [
          {
            ...component,
            status: 'pending',
            amountUsd: null,
            credits: null,
            reason: 'settlement_pending',
          },
          receipt.components[1],
        ],
        retryAfterSeconds: 5,
      }),
    );
  } else {
    res.end(JSON.stringify({ ...receipt, privateToken: 'must-not-leak' }));
  }
});
let client: Client;
let server: ReturnType<Awaited<ReturnType<typeof createMcpServerFactory>>['createServer']>;
let baseUrl: string;
beforeAll(async () => {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
  server = factory.createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  await client.connect(ct);
});
afterAll(async () => {
  await client?.close();
  await server?.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});
const call = (token: string, args: Record<string, unknown> = { generationId }) =>
  runWithAuth(token, 'openai-mcp', () =>
    client.callTool({ name: 'get-generation-costs', arguments: args }),
  );

it('exposes a read tool to ChatGPT and forwards only an authenticated generation-cost GET', async () => {
  const catalog = await client.listTools();
  const tool = catalog.tools.find((entry) => entry.name === 'get-generation-costs');
  expect(tool).toMatchObject({
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    outputSchema: expect.any(Object),
  });
  const before = requests.length;
  const result = await call('account-one');
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual(receipt);
  expect(requests.slice(before)).toEqual([
    { method: 'GET', path: `/v2/generate/${generationId}/costs`, auth: 'Bearer account-one' },
  ]);
  expect(JSON.stringify(result)).not.toContain('must-not-leak');
  expect(catalog.tools.filter((entry) => entry.name.includes('generation-costs'))).toHaveLength(1);
});

it('preserves unknown costs and pending components instead of manufacturing a total', async () => {
  const result = await call('partial');
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    availability: 'partial',
    totalCostUsd: null,
    knownSubtotalUsd: '0.16000',
    components: [
      { status: 'pending', amountUsd: null },
      { type: 'dubbing', amountUsd: '0.16000' },
    ],
  });
});

it('does not turn authentication or upstream failures into cost receipts', async () => {
  const unauthorized = await call('unauthorized');
  expect(unauthorized.isError).toBe(true);
  expect(unauthorized._meta).toHaveProperty('mcp/www_authenticate');
  const outage = await call('outage');
  expect(outage.isError).toBe(true);
  expect(outage.structuredContent).toMatchObject({ error: { status: 503 } });
});

it('rejects invalid IDs before contacting the API', async () => {
  const before = requests.length;
  for (const args of [{ generationId: 'not-an-id' }, { generationId: '' }]) {
    expect((await call('account-one', args)).isError).toBe(true);
  }
  expect(requests).toHaveLength(before);
});

it('does not advertise cost retrieval against an API without that capability', async () => {
  const factory = await createMcpServerFactory({
    baseUrl: `${baseUrl}/old`,
    transport: 'http',
    port: 0,
  });
  const oldServer = factory.createServer();
  const oldClient = new Client({ name: 'openai-mcp', version: '1.0.0' });
  try {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await oldServer.connect(st);
    await oldClient.connect(ct);
    expect(
      (await oldClient.listTools()).tools.some((tool) => tool.name === 'get-generation-costs'),
    ).toBe(false);
  } finally {
    await oldClient.close();
    await oldServer.close();
  }
});
