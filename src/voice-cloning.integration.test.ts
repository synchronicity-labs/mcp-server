import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';

const assetId = '00000000-0000-4000-8000-000000000001';
const voiceId = '00000000-0000-4000-8000-000000000002';
const projectId = '00000000-0000-4000-8000-000000000003';
const input = { name: 'My narration', provider: 'elevenlabs', assetId };
const upstreams: Server[] = [];
const clients: Client[] = [];
const servers: McpServer[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const upstream of upstreams.splice(0)) {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

async function fixture(
  options: { available?: boolean; status?: number; code?: string; dropResponse?: boolean } = {},
) {
  const calls: Array<{
    method: string;
    path: string;
    body: unknown;
    auth?: string;
    source?: string;
  }> = [];
  let cloned = false;
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api-json') {
      res.end(
        JSON.stringify({
          openapi: '3.0.0',
          paths: {
            '/v2/voices': {
              get: { operationId: 'VoicesController_getVoices', tags: ['Voices'] },
              ...(options.available === false
                ? {}
                : {
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
                                name: { type: 'string', minLength: 1, maxLength: 100 },
                                provider: { type: 'string', enum: ['elevenlabs'] },
                                assetId: { type: 'string', format: 'uuid' },
                                url: { type: 'string', format: 'uri' },
                              },
                              // The live API puts the exclusive sample sources in allOf/oneOf.
                              allOf: [
                                {
                                  oneOf: [
                                    {
                                      type: 'object',
                                      properties: { url: { type: 'string', format: 'uri' } },
                                      required: ['url'],
                                    },
                                    {
                                      type: 'object',
                                      properties: { assetId: { type: 'string', format: 'uuid' } },
                                      required: ['assetId'],
                                    },
                                  ],
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                  }),
              delete: { operationId: 'VoicesController_deleteVoice', tags: ['Voices'] },
            },
          },
        }),
      );
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    calls.push({
      method: req.method!,
      path: req.url!,
      body: raw ? JSON.parse(raw) : undefined,
      auth: req.headers.authorization,
      source: req.headers['x-sync-source'] as string | undefined,
    });
    if (req.url === '/v2/voices' && req.method === 'POST') {
      if (!options.code) cloned = true;
      if (options.dropResponse) {
        res.destroy();
        return;
      }
      res.statusCode = options.status ?? 201;
      if (options.code) res.setHeader('Retry-After', '60');
      res.end(
        JSON.stringify(
          options.code
            ? { message: 'Voice request refused', errorCode: options.code }
            : { id: voiceId, voiceId: 'provider-id-not-the-sync-id', name: input.name },
        ),
      );
    } else if (req.url === '/v2/voices') {
      res.end(
        JSON.stringify(cloned ? [{ id: voiceId, name: input.name, provider: 'elevenlabs' }] : []),
      );
    } else if (req.url === `/v2/projects/${projectId}`) {
      res.end(JSON.stringify({ id: projectId }));
    } else if (req.url === '/v2/generate') {
      res.end(JSON.stringify({ id: 'fixture-generation', status: 'PENDING' }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  upstreams.push(upstream);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'http',
    port: 0,
  });
  const server = factory.createServer();
  servers.push(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  clients.push(client);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    runWithAuth('fixture-account-token', 'openai-mcp', () =>
      client.callTool({ name, arguments: args }),
    );
  return { client, calls, call };
}

it('advertises voice creation as a non-idempotent external write, without enabling deletion', async () => {
  const { client } = await fixture();
  const tools = (await client.listTools()).tools;
  const clone = tools.find((tool) => tool.name === 'voices_clone-voice');
  expect(clone?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  expect(clone?._meta?.securitySchemes).toEqual([{ type: 'oauth2', scopes: [] }]);
  expect(clone?.inputSchema.required).toEqual(['name', 'provider']);
  expect(tools.some((tool) => tool.name === 'voices_delete-voice')).toBe(false);
});

it('clones once from a saved sample and reuses the internal id for script generation', async () => {
  const { calls, call } = await fixture();
  const result = await call('voices_clone-voice', input);
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ id: voiceId, name: input.name });
  await call('voices_get-voices', {});
  const generation = await call('create-lipsync', {
    imageAssetId: assetId,
    script: 'Hello',
    voiceId: z.object({ id: z.uuid() }).parse(result.structuredContent).id,
    projectId,
  });
  expect(generation.isError).not.toBe(true);
  expect(calls[0]).toEqual({
    method: 'POST',
    path: '/v2/voices',
    body: input,
    auth: 'Bearer fixture-account-token',
    source: 'mcp:openai-mcp',
  });
  expect(calls.filter((call) => call.path === '/v2/voices' && call.method === 'POST')).toHaveLength(
    1,
  );
  expect(calls.at(-1)?.body).toMatchObject({
    input: [
      { type: 'image', assetId },
      { type: 'text', provider: { name: 'elevenlabs', voiceId, script: 'Hello' } },
    ],
  });
});

it('passes a Sync-hosted sample URL verbatim for API validation', async () => {
  const { calls, call } = await fixture();
  const url = 'https://storage.fixture.invalid/sample.mp4?Signature=a%2Fb';
  const result = await call('voices_clone-voice', {
    name: input.name,
    provider: input.provider,
    url,
  });
  expect(result.isError).not.toBe(true);
  expect(calls[0]?.body).toEqual({ name: input.name, provider: input.provider, url });
});

it.each([
  {},
  { assetId, url: 'https://storage.fixture.invalid/sample.wav' },
  { assetId: 'not-an-id' },
  { url: 'not-a-url' },
])('rejects missing or ambiguous clone samples before sending a write: %j', async (sample) => {
  const { calls, call } = await fixture();
  const result = await call('voices_clone-voice', {
    name: input.name,
    provider: input.provider,
    ...sample,
  });
  expect(result.isError).toBe(true);
  expect(calls).toHaveLength(0);
});

it('does not repeat a clone when the API receives the write but loses its response', async () => {
  const { calls, call } = await fixture({ dropResponse: true });
  expect((await call('voices_get-voices', {})).content).toEqual([{ type: 'text', text: '[]' }]);
  expect((await call('voices_clone-voice', input)).isError).toBe(true);
  expect((await call('voices_get-voices', {})).content).toEqual([
    {
      type: 'text',
      text: JSON.stringify([{ id: voiceId, name: input.name, provider: 'elevenlabs' }], null, 2),
    },
  ]);
  expect(calls.filter((request) => request.method === 'POST')).toHaveLength(1);
});

it.each([
  [400, 'VOICE_SAMPLE_TOO_SHORT'],
  [403, 'VOICE_CLONE_LIMIT_REACHED'],
  [409, 'VOICE_NAME_EXISTS'],
  [422, 'ASSET_NOT_FOUND'],
  [429, 'RATE_LIMIT_EXCEEDED'],
  [500, 'PROVIDER_ERROR'],
])('preserves API refusal %s/%s and never retries the write', async (status, code) => {
  const { calls, call } = await fixture({ status: status as number, code: code as string });
  const result = await call('voices_clone-voice', input);
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { status, code, retryAfterMs: 60_000 } },
  });
  expect(calls).toHaveLength(1);
});

it('does not advertise cloning when the connected API has no clone operation', async () => {
  const { client, calls } = await fixture({ available: false });
  expect((await client.listTools()).tools.some((tool) => tool.name === 'voices_clone-voice')).toBe(
    false,
  );
  expect(calls).toHaveLength(0);
});
