import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

it.each(['complete', 'complete-with-analytics', 'missing-create', 'missing-get', 'missing-key'])(
  'discovers hosted audio preparation only with its complete contract: %s',
  async (scenario) => {
    const id = '00000000-0000-4000-8000-000000000001';
    const paths: Record<string, Record<string, object>> = {};
    if (scenario !== 'missing-create')
      paths['/v2/audio-trims'] = {
        post: {
          operationId: 'AudioTrimsController_create',
          tags: ['Audio trims'],
          parameters:
            scenario === 'missing-key'
              ? []
              : [
                  {
                    name: 'Idempotency-Key',
                    in: 'header',
                    required: true,
                    schema: { type: 'string' },
                  },
                ],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    assetId: { type: 'string', format: 'uuid' },
                    durationSeconds: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      };
    if (scenario !== 'missing-get')
      paths['/v2/audio-trims/{id}'] = {
        get: { operationId: 'AudioTrimsController_get', tags: ['Audio trims'] },
      };
    if (scenario === 'complete-with-analytics')
      paths['/v2/analytics/chatgpt-events'] = {
        post: { operationId: 'analytics_captureChatgptEvent', tags: ['Analytics'] },
      };
    const writes: { key: string | string[] | undefined; body: string }[] = [];
    const upstream = createServer(asyncRequestListener(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api-json') res.end(JSON.stringify({ openapi: '3.0.0', paths }));
      else if (req.url === '/v2/oauth/account')
        res.end(
          JSON.stringify({ account: null, organization: { id, name: 'test', role: 'owner' } }),
        );
      else if (req.url === '/v2/plans/limits') res.end(JSON.stringify({ seats: 1, voiceClone: 1 }));
      else if (req.url === '/v2/audio-trims') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        writes.push({
          key: req.headers['idempotency-key'],
          body: Buffer.concat(chunks).toString(),
        });
        res.end(
          JSON.stringify({
            id,
            status: 'queued',
            assetId: null,
            durationSeconds: null,
            errorCode: null,
            retryAfterMs: 2000,
          }),
        );
      } else {
        res.statusCode = 500;
        res.end('{}');
      }
    }));
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const factory = await createMcpServerFactory({
      baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      transport: 'http',
      port: 0,
    });
    const server = factory.createServer();
    const client = new Client({ name: 'openai-mcp', version: 'trim-test' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      const enabled = scenario.startsWith('complete');
      expect(names.includes('trim-audio')).toBe(enabled);
      expect(names.includes('get-audio-trim')).toBe(enabled);
      expect(names).not.toContain('audio-trims_create');
      const account = await runWithAuth('trim-user', 'openai-mcp', () =>
        client.callTool({ name: 'get-account-context', arguments: {} }),
      );
      if (scenario === 'complete-with-analytics')
        expect(account.structuredContent).toHaveProperty('capabilities.chatgptAnalytics', true);
      else expect(account.structuredContent).not.toHaveProperty('capabilities.chatgptAnalytics');
      if (enabled) {
        expect(account.structuredContent).toMatchObject({ capabilities: { audioTrimming: true } });
        const trim = await runWithAuth('trim-user', 'openai-mcp', () =>
          client.callTool({
            name: 'trim-audio',
            arguments: { audioAssetId: id, durationSeconds: 15, idempotencyKey: id },
          }),
        );
        expect(trim.isError).not.toBe(true);
        expect(writes).toEqual([
          { key: id, body: JSON.stringify({ durationSeconds: 15, assetId: id }) },
        ]);
      } else expect(account.structuredContent).not.toHaveProperty('capabilities.audioTrimming');
    } finally {
      await client.close();
      await server.close();
      upstream.close();
      await once(upstream, 'close');
    }
  },
);
