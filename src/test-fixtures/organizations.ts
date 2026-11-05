// A stub Sync API with two organizations the user belongs to, for the organization tests.
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { runWithAuth } from '../auth/async-context.js';
import { ORGANIZATION_HEADER } from '../organization-selection.js';
import { createMcpServerFactory } from '../server.js';
import { asyncRequestListener } from './request-listener.js';

export const HOME = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Home' };
export const ACME = { id: '00000000-0000-4000-8000-0000000000a2', name: 'Acme' };
export const FOREIGN = '00000000-0000-4000-8000-0000000000a3';
export const PROJECT = '00000000-0000-4000-8000-0000000000b1';
export const GENERATION = '00000000-0000-4000-8000-0000000000c1';
const USER = { id: '00000000-0000-4000-8000-0000000000d1', email: 'u@example.test', name: 'U' };

const ORGS = {
  [HOME.id]: {
    ...HOME,
    role: 'owner',
    plan: { id: 'free', name: 'Free' },
    limits: { concurrency: 1, maxOutputDurationSeconds: 60 },
    features: { 'stem-separation': true, 'scene-detection': false },
  },
  [ACME.id]: {
    ...ACME,
    role: 'member',
    plan: { id: 'scale', name: 'Scale' },
    limits: { concurrency: 15, maxOutputDurationSeconds: 1800 },
    features: { 'stem-separation': true, 'scene-detection': true },
  },
} as const;

const spec = {
  openapi: '3.0.0',
  paths: {
    '/v2/generate/{id}': {
      get: {
        operationId: 'GenerateController_getGeneration',
        tags: ['Generate'],
        summary: 'Get a generation',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  },
};

export type Call = {
  method: string;
  url: string;
  organization?: string;
  headers: IncomingHttpHeaders;
};

/** Closes stubs and clients; call from each test file's afterEach. */
const cleanups: (() => Promise<void> | void)[] = [];
export function onCleanUp(cleanup: () => Promise<void> | void): void {
  cleanups.push(cleanup);
}
export async function cleanUp(): Promise<void> {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
}

type Org = (typeof ORGS)[keyof typeof ORGS];
type Reply = [status: number, body: unknown];

const refusal = (message: string, errorCode: string): Reply => [403, { message, errorCode }];

/** Account reads as the API answers them for `org`. */
function accountReply(url: string, org: Org, apiKey: boolean): Reply | undefined {
  const organization = { id: org.id, name: org.name, role: apiKey ? 'owner' : org.role };
  const account = apiKey ? null : USER;
  const replies: Record<string, unknown> = {
    '/v2/account': {
      account,
      organization,
      credentialType: apiKey ? 'api_key' : 'session',
      plan: org.plan,
      limits: { ...org.limits, maxFileSizeBytes: 1 },
      features: org.features,
    },
    '/v2/oauth/account': { account, organization },
    '/v2/plans/limits': { seats: 3, voiceClone: 5 },
    '/v2/account/organizations': {
      organizations: Object.values(ORGS).map((item) => ({
        id: item.id,
        name: item.name,
        role: item.role,
        plan: item.plan,
        isCurrent: item.id === org.id,
      })),
    },
  };
  return url in replies ? [200, replies[url]] : undefined;
}

function generationReply(method: string, url: string, body: Record<string, unknown>): Reply {
  if (method === 'POST' && url === '/v2/projects') return [200, { id: body.id ?? PROJECT }];
  if (method === 'GET' && url.startsWith('/v2/projects/'))
    return [200, { id: url.slice('/v2/projects/'.length) }];
  if (method === 'POST' && url === '/v2/generate')
    return [200, { id: GENERATION, status: 'PENDING', projectId: body.projectId }];
  if (url.startsWith(`/v2/generate/${GENERATION}`))
    return [200, { id: GENERATION, status: 'PROCESSING' }];
  return [404, { message: `Cannot ${method} ${url}` }];
}

/**
 * A Sync API that honours the organization header for users, unless `ignoresHeader`.
 * `intercept` can hold a request or answer it instead.
 */
export async function api(
  options: {
    ignoresHeader?: boolean;
    intercept?: (call: Call) => Promise<Reply | undefined> | Reply | undefined;
  } = {},
) {
  const calls: Call[] = [];
  const reply = (call: Call, body: Record<string, unknown>): Reply => {
    const apiKey = call.headers['x-api-key'] !== undefined;
    const requested = call.organization;
    if (requested && apiKey)
      return refusal(
        'API keys are bound to their organization',
        'organization_selection_not_allowed',
      );
    if (requested && !(requested in ORGS))
      return refusal('You are not a member of this organization', 'organization_access_denied');
    const org = ORGS[requested && !options.ignoresHeader ? requested : HOME.id]!;
    return accountReply(call.url, org, apiKey) ?? generationReply(call.method, call.url, body);
  };
  const upstream: Server = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') return void res.end(JSON.stringify(spec));
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const header = req.headers[ORGANIZATION_HEADER];
      const call: Call = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        ...(typeof header === 'string' ? { organization: header } : {}),
      };
      calls.push(call);
      const [status, body] =
        (await options.intercept?.(call)) ??
        reply(call, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      res.writeHead(status).end(JSON.stringify(body));
    }),
  );
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  cleanups.push(() => void upstream.close());
  return { baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, calls };
}

export async function connect(server: { connect: (transport: never) => Promise<void> }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as never);
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(clientTransport);
  cleanups.push(() => client.close());
  return client;
}

/** A hosted server over the in-memory transport; tool calls run as an OAuth user. */
export async function hosted(baseUrl: string) {
  const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
  const client = await connect(factory.createServer());
  return {
    call: (name: string, args: Record<string, unknown> = {}) =>
      runWithAuth('oauth-user', 'claude-code', () => client.callTool({ name, arguments: args })),
  };
}

export const lipsync = {
  videoUrl: 'https://example.test/v.mp4',
  audioUrl: 'https://example.test/a.wav',
  projectCreationKey: '00000000-0000-4000-8000-0000000000e1',
};
