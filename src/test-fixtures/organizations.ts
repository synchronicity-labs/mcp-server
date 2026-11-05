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
/** The user belongs to it, but the app connection wasn't granted it at consent. */
export const UNGRANTED = '00000000-0000-4000-8000-0000000000a4';
export const PROJECT = '00000000-0000-4000-8000-0000000000b1';
export const GENERATION = '00000000-0000-4000-8000-0000000000c1';
const USER = { id: '00000000-0000-4000-8000-0000000000d1', email: 'u@example.test', name: 'U' };

const ORGS = {
  [HOME.id]: {
    ...HOME,
    role: 'owner',
    plan: { id: 'free', name: 'Free' },
    limits: { concurrency: 1, maxOutputDurationSeconds: 60 },
    features: ['stem_separation'],
  },
  [ACME.id]: {
    ...ACME,
    role: 'member',
    plan: { id: 'scale', name: 'Scale' },
    limits: { concurrency: 15, maxOutputDurationSeconds: 1800 },
    features: ['stem_separation', 'scene_detection'],
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

// sync-api-v2 #7863 refusals: coded, with the API's suggestion.
const REFUSALS = {
  api_key_organization_bound: [
    'API keys are bound to their organization and cannot act in another one.',
    "Omit x-sync-organization-id, or use an API key created in the other organization's Studio settings.",
  ],
  organization_access_denied: [
    'You are not a member of the organization named in x-sync-organization-id.',
    'Use an organization id from GET /v2/account/organizations, or omit the header to use your default organization.',
  ],
  oauth_organization_not_granted: [
    'This app connection has not been granted access to the organization named in x-sync-organization-id.',
    'To add it, reconnect the app and tick that organization on the consent screen, keeping the others you still want. Until then, use an organization from GET /v2/account/organizations or omit the header.',
  ],
} as const;
const refusal = (errorCode: keyof typeof REFUSALS): Reply => [
  403,
  { message: REFUSALS[errorCode][0], errorCode, suggestion: REFUSALS[errorCode][1] },
];

/** Account reads as the API answers them for `org`. */
function accountReply(url: string, org: Org, apiKey: boolean): Reply | undefined {
  const organization = { id: org.id, name: org.name, role: apiKey ? 'member' : org.role };
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
      // An API key lists only its own organization.
      organizations: Object.values(ORGS)
        .filter((item) => !apiKey || item.id === org.id)
        .map((item) => ({
          id: item.id,
          name: item.name,
          role: apiKey ? 'member' : item.role,
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
    if (requested && apiKey && requested !== HOME.id) return refusal('api_key_organization_bound');
    if (requested === UNGRANTED) return refusal('oauth_organization_not_granted');
    if (requested && !(requested in ORGS)) return refusal('organization_access_denied');
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
