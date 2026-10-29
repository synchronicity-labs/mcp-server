import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';

it.each([
  true,
  false,
])('gates authenticated app telemetry on collector discovery (%s)', async (available) => {
  const id = '22222222-2222-4222-8222-222222222222';
  const calls: { auth?: string; source?: string; body: unknown }[] = [];
  const upstream = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api-json') {
      res.end(
        JSON.stringify({
          openapi: '3.0.0',
          paths: available
            ? {
                '/v2/analytics/chatgpt-events': {
                  post: { operationId: 'analytics_captureChatgptEvent', tags: ['Analytics'] },
                },
              }
            : {},
        }),
      );
    } else if (req.url === '/v2/oauth/account') {
      res.end(
        JSON.stringify({
          account: { id, email: null, name: null },
          organization: { id, name: null, role: 'owner' },
        }),
      );
    } else if (req.url === '/v2/plans/limits') {
      res.end(JSON.stringify({ seats: 1, voiceClone: 1 }));
    } else if (req.url === '/v2/analytics/chatgpt-events') {
      let raw = '';
      for await (const part of req) raw += part;
      calls.push({
        auth: req.headers.authorization,
        source: String(req.headers['x-sync-source']),
        body: JSON.parse(raw),
      });
      res.end('{}');
    } else {
      res.statusCode = 404;
      res.end('{}');
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
  const client = new Client({ name: 'openai-mcp', version: 'analytics-test' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const tools = (await client.listTools()).tools;
    if (!available) {
      expect(tools.some((tool) => tool.name === 'track-chatgpt-event')).toBe(false);
      const account = await runWithAuth('fixture-user', 'openai-mcp', () =>
        client.callTool({ name: 'get-account-context', arguments: {} }),
      );
      expect(account.structuredContent).not.toHaveProperty('capabilities.chatgptAnalytics');
      expect(calls).toEqual([]);
      return;
    }
    expect(tools.find((tool) => tool.name === 'track-chatgpt-event')?._meta?.ui).toMatchObject({
      visibility: ['app'],
    });
    const account = await runWithAuth('fixture-user', 'openai-mcp', () =>
      client.callTool({ name: 'get-account-context', arguments: {} }),
    );
    expect(account.structuredContent).toMatchObject({ capabilities: { chatgptAnalytics: true } });
    expect(account.structuredContent).not.toHaveProperty('capabilities.audioTrimming');
    const event = {
      event: 'chatgpt_ui_loaded',
      event_id: id,
      attribution: { version: 1, invocation_source: 'ui', journey_id: id },
    };
    const result = await runWithAuth('fixture-user', 'openai-mcp', () =>
      client.callTool({
        name: 'track-chatgpt-event',
        arguments: event,
        _meta: { 'openai/session': 'private-host-session' },
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ accepted: true });
    expect(calls).toEqual([
      {
        auth: 'Bearer fixture-user',
        source: 'mcp:openai-mcp',
        body: {
          ...event,
          attribution: {
            ...event.attribution,
            conversation_id: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      },
    ]);
  } finally {
    await client.close();
    await server.close();
    upstream.close();
    await once(upstream, 'close');
  }
});
