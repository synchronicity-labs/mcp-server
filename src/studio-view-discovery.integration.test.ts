import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';

const operations = [
  ['StudioViewsController_get', '/v2/studio-views/{viewId}', 'get'],
  ['StudioViewsController_register', '/v2/studio-views/{viewId}', 'put'],
  ['StudioViewsController_request', '/v2/studio-views/{viewId}/actions', 'post'],
  ['StudioViewsController_acknowledge', '/v2/studio-views/{viewId}/acknowledgement', 'post'],
] as const;
const cases = [
  { name: 'complete version 1', operationId: '', defect: '', enabled: true },
  ...operations.flatMap(([operationId]) =>
    ['missing', 'method', 'unversioned', 'version'].map((defect) => ({
      name: `${operationId}: ${defect}`,
      operationId,
      defect,
      enabled: false,
    })),
  ),
];

it.each(cases)('advertises Studio view tools/capability only for a complete API: $name', async ({
  operationId,
  defect,
  enabled,
}) => {
  const paths: Record<string, Record<string, object>> = {};
  for (const [id, path, method] of operations) {
    if (id === operationId && defect === 'missing') continue;
    paths[path] ??= {};
    paths[path][id === operationId && defect === 'method' ? 'patch' : method] = {
      operationId: id,
      tags: ['Projects'],
      parameters: [{ name: 'viewId', in: 'path', required: true, schema: { type: 'string' } }],
      ...(id === operationId && defect === 'unversioned'
        ? {}
        : { 'x-sync-studio-views': id === operationId && defect === 'version' ? 2 : 1 }),
    };
  }
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api-json') res.end(JSON.stringify({ openapi: '3.0.0', paths }));
    else if (req.url === '/v2/oauth/account')
      res.end(
        JSON.stringify({
          account: null,
          organization: { id: '00000000-0000-4000-8000-000000000001', name: 'test', role: 'owner' },
        }),
      );
    else if (req.url === '/v2/plans/limits') res.end(JSON.stringify({ seats: 1, voiceClone: 1 }));
    else {
      res.statusCode = 500;
      res.end(JSON.stringify({ message: 'Unexpected request' }));
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'http',
    port: 0,
  });
  const server = factory.createServer();
  const client = new Client({ name: 'openai-mcp', version: 'view-discovery-test' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      'get-studio-view',
      'request-studio-view-action',
      'register-studio-view',
      'ack-studio-view',
    ])
      expect(names.includes(name)).toBe(enabled);
    const result = await runWithAuth('view-user', 'openai-mcp', () =>
      client.callTool({ name: 'get-account-context', arguments: {} }),
    );
    expect(result.isError).not.toBe(true);
    if (enabled)
      expect(result.structuredContent).toMatchObject({ capabilities: { studioViewSync: true } });
    else expect(result.structuredContent).not.toHaveProperty('capabilities.studioViewSync');
  } finally {
    await client.close();
    await server.close();
    upstream.close();
    await once(upstream, 'close');
  }
});
