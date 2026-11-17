import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it } from 'vitest';
import { createSyncMcpServer } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';

// The whole path over a stdio-style connection: a client that declares elicitation, a
// paid generated tool (voices_clone) and the account read that decides whether to ask.
const assetId = '00000000-0000-4000-8000-000000000001';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

const spec = {
  openapi: '3.0.0',
  paths: {
    '/v2/voices': {
      post: {
        operationId: 'VoicesController_cloneVoice',
        tags: ['Voices'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'provider'],
                properties: {
                  name: { type: 'string' },
                  provider: { type: 'string', enum: ['elevenlabs'] },
                  assetId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
      },
    },
  },
};

async function setup({
  account,
  elicitation,
  spendConfirmation = true,
}: {
  account: Record<string, unknown>;
  elicitation?: 'approve' | 'decline';
  spendConfirmation?: boolean;
}) {
  const calls: string[] = [];
  const upstream: Server = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') return void res.end(JSON.stringify(spec));
      for await (const _chunk of req);
      if (req.url !== '/v2/account') calls.push(`${req.method} ${req.url}`);
      if (req.url === '/v2/billing') return void res.end(JSON.stringify(account));
      if (req.url === '/v2/voices' && req.method === 'POST') {
        res.statusCode = 201;
        return void res.end(JSON.stringify({ id: 'voice-1', name: 'Narration' }));
      }
      if (req.url === '/v2/account')
        return void res.end(JSON.stringify({ organization: { id: 'org', name: 'Org' } }));
      res.statusCode = 404;
      res.end('{}');
    }),
  );
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  cleanups.push(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const server = await createSyncMcpServer({
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'stdio',
    port: 0,
    spendConfirmation,
    toolsets: ['all'],
  });
  cleanups.push(() => server.close());
  const questions: string[] = [];
  const client = new Client(
    { name: 'claude-code', version: '1.0.0' },
    elicitation ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  if (elicitation)
    client.setRequestHandler('elicitation/create', async (request) => {
      questions.push(String(request.params.message));
      return elicitation === 'approve'
        ? { action: 'accept', content: { approve: true } }
        : { action: 'decline' };
    });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  cleanups.push(() => client.close());
  await client.connect(clientTransport);
  const clone = () =>
    client.callTool({
      name: 'voices_clone',
      arguments: { name: 'Narration', provider: 'elevenlabs', assetId },
    });
  return { calls, questions, clone };
}

const paid = { plan: 'creator', hasActiveCredits: false, elevenLabsKeyConnected: false };
const free = { plan: null, hasActiveCredits: false, elevenLabsKeyConnected: false, credits: null };

it('asks the person before paid work, and starts nothing when they decline', async () => {
  const { calls, questions, clone } = await setup({ account: paid, elicitation: 'decline' });
  const result = await clone();
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ error: { code: 'SPEND_NOT_APPROVED' } });
  expect(questions).toEqual([expect.stringContaining('a voice clone')]);
  expect(calls).not.toContain('POST /v2/voices');
});

it('starts paid work once the person approves', async () => {
  const { calls, questions, clone } = await setup({ account: paid, elicitation: 'approve' });
  expect((await clone()).isError).toBeFalsy();
  expect(questions).toHaveLength(1);
  expect(calls).toEqual(['GET /v2/billing', 'POST /v2/voices']);
});

it('does not ask when the free allowance is all the account can use', async () => {
  const { calls, questions, clone } = await setup({ account: free, elicitation: 'decline' });
  expect((await clone()).isError).toBeFalsy();
  expect(questions).toHaveLength(0);
  expect(calls).toContain('POST /v2/voices');
});

it('changes nothing for a client that cannot be asked', async () => {
  const { calls, clone } = await setup({ account: paid });
  expect((await clone()).isError).toBeFalsy();
  expect(calls).toEqual(['POST /v2/voices']);
});

it('changes nothing in unattended mode', async () => {
  const { calls, questions, clone } = await setup({
    account: paid,
    elicitation: 'decline',
    spendConfirmation: false,
  });
  expect((await clone()).isError).toBeFalsy();
  expect(questions).toHaveLength(0);
  expect(calls).toEqual(['POST /v2/voices']);
});
