import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';
import { TelemetrySession } from './telemetry/index.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

// feedback_send in the hosted ChatGPT app: listed, instructed, and tied to the session's
// usage events when the API's feedback schema takes those fields.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

function spec(linkFields: boolean) {
  const properties: Record<string, unknown> = {
    kind: { type: 'string' },
    message: { type: 'string' },
    ...(linkFields && {
      mcpSessionId: { type: 'string', format: 'uuid' },
      conversationId: { type: 'string' },
    }),
  };
  return {
    openapi: '3.0.0',
    paths: {
      '/v2/feedback': {
        post: {
          operationId: 'agentFeedback_submit',
          tags: ['Feedback'],
          requestBody: { content: { 'application/json': { schema: { properties } } } },
        },
      },
      '/v2/analytics/mcp-events': {
        post: { operationId: 'analytics_captureMcpEvents', tags: ['Analytics'] },
      },
      '/v2/generate/{id}': {
        get: {
          operationId: 'GenerateController_getGeneration',
          tags: ['Generate'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        },
      },
    },
  };
}

async function setup(linkFields: boolean) {
  const feedback: Record<string, unknown>[] = [];
  const events: { event: string; properties: Record<string, unknown> }[] = [];
  const api = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') return void res.end(JSON.stringify(spec(linkFields)));
      let raw = '';
      for await (const chunk of req) raw += chunk;
      if (req.url === '/v2/feedback') {
        feedback.push(JSON.parse(raw));
        return void res.end(JSON.stringify({ id: 'feedback-1', received: true }));
      }
      if (req.url?.startsWith('/v2/generate/')) {
        return void res.end(JSON.stringify({ id: GENERATION, status: 'COMPLETED' }));
      }
      if (req.url === '/v2/analytics/mcp-events') {
        events.push(...JSON.parse(raw).events);
        res.statusCode = 202;
        return void res.end('{}');
      }
      res.statusCode = 404;
      res.end('{}');
    }),
  );
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  cleanups.push(async () => {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
    transport: 'http',
    port: 0,
  });
  const telemetry = new TelemetrySession(factory.telemetry!, 'http');
  telemetry.setClient('openai-mcp', '1.0.0');
  const server = factory.createServer(undefined, 'openai-mcp', telemetry);
  const owner = JSON.stringify(['user-1', 'client-1', null]);
  const run = <T>(fn: () => Promise<T>) => runWithAuth('fixture-token', 'openai-mcp', fn, owner);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  await run(() => client.connect(ct));
  cleanups.push(() => client.close().catch(() => {}));
  return { client, run, feedback, events, telemetry, flush: () => factory.telemetry!.flush() };
}

const report = {
  kind: 'missing_capability',
  message: 'Asked to remove background noise from a clip before dubbing it.',
  severity: 'major',
};
const session = 'chatgpt-session-handle';
const GENERATION = '0b6c6a1e-3c5e-4a51-9f0e-4b7c2b1d9a10';

describe('feedback_send in ChatGPT', () => {
  it('is listed and instructed, including for requests the tools cannot do', async () => {
    const { client, run } = await setup(false);
    const { tools } = await run(() => client.listTools());
    expect(tools.map((tool) => tool.name)).toContain('feedback_send');
    expect(client.getInstructions()).toContain('call feedback_send once');
    expect(client.getInstructions()).toContain('kind missing_capability');
  });

  it('sends no link fields the API does not take yet', async () => {
    const { client, run, feedback } = await setup(false);
    await run(() =>
      client.callTool({
        name: 'feedback_send',
        arguments: report,
        _meta: { 'openai/session': session },
      }),
    );
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).not.toHaveProperty('mcpSessionId');
    expect(feedback[0]).not.toHaveProperty('conversationId');
    expect(feedback[0]).toMatchObject({ ...report, client: { name: 'openai-mcp' } });
  });

  it('names the conversation’s latest generation on a report about a result that left it out', async () => {
    const { client, run, feedback } = await setup(false);
    const call = (name: string, args: Record<string, unknown>, conversation = session) =>
      run(() =>
        client.callTool({
          name,
          arguments: args,
          _meta: { 'openai/session': conversation },
        }),
      );
    await call('generations_get', { id: GENERATION });
    const bug = { kind: 'bug', message: 'The result shows no visible lipsync.' };

    await call('feedback_send', bug);
    // Not for a missing capability, nor for another conversation.
    await call('feedback_send', report);
    await call('feedback_send', bug, 'another-conversation');
    // An id the agent gave stays as given.
    const named = '00000000-0000-4000-8000-000000000002';
    await call('feedback_send', { ...bug, generationId: named });

    expect(feedback.map((body) => body.generationId)).toEqual([
      GENERATION,
      undefined,
      undefined,
      named,
    ]);
  });

  it('names its session and conversation, matching the usage events', async () => {
    const { client, run, feedback, events, telemetry, flush } = await setup(true);
    await run(() =>
      client.callTool({
        name: 'feedback_send',
        arguments: report,
        _meta: { 'openai/session': session },
      }),
    );
    const conversationId = createHash('sha256').update(session).digest('hex');
    expect(feedback[0]).toMatchObject({ mcpSessionId: telemetry.id, conversationId });
    flush();
    for (let i = 0; i < 100 && events.length === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events[0]).toMatchObject({
      event: 'mcp_tool_called',
      properties: {
        session_id: telemetry.id,
        conversation_id: conversationId,
        tool_name: 'feedback_send',
        outcome: 'success',
        args: { kind: 'missing_capability', severity: 'major', message: 'text:21-100' },
      },
    });
  });
});
