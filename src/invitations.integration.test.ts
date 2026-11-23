import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';
import type { Toolset } from './toolsets.js';

const INVITATION_ID = '00000000-0000-4000-8000-0000000000aa';
const INVITATION_TOOLS = [
  'invitations_create',
  'invitations_delete',
  'invitations_list',
  'invitations_resend',
];

const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const idParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }];

// The invitation operations as api.sync.so/api-json publishes them on 2026-11-23.
const spec = {
  openapi: '3.0.0',
  paths: {
    '/v2/invitations': {
      get: {
        operationId: 'InvitationsController_getAll',
        tags: ['Invitations'],
        summary: 'List invitations',
        parameters: [
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['pending', 'accepted', 'expired'] },
          },
        ],
      },
      post: {
        operationId: 'InvitationsController_invite',
        tags: ['Invitations'],
        summary: 'Invite members',
        requestBody: json({
          type: 'object',
          required: ['invitations'],
          properties: {
            invitations: {
              type: 'array',
              items: {
                type: 'object',
                required: ['email', 'role'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  role: { type: 'string', enum: ['member', 'admin'] },
                },
              },
            },
          },
        }),
      },
    },
    '/v2/invitations/{id}': {
      delete: {
        operationId: 'InvitationsController_delete',
        tags: ['Invitations'],
        summary: 'Cancel an invitation',
        parameters: idParam,
      },
    },
    '/v2/invitations/{id}/resend': {
      post: {
        operationId: 'InvitationsController_resend',
        tags: ['Invitations'],
        summary: 'Resend an invitation',
        parameters: idParam,
      },
    },
  },
};

type Request = { method: string; url: string; body: string };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

const invitation = {
  id: INVITATION_ID,
  email: 'new.person@example.com',
  organizationId: '00000000-0000-4000-8000-000000000001',
  invitedByUserId: '00000000-0000-4000-8000-000000000002',
  role: 'member',
  status: 'pending',
  expiresAt: '2026-11-30T00:00:00.000Z',
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: null,
  isResend: false,
};

async function api() {
  const requests: Request[] = [];
  const upstream: Server = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') return void res.end(JSON.stringify(spec));
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      if (req.url === '/v2/oauth/account')
        return void res.end(
          JSON.stringify({
            account: null,
            organization: { id: invitation.organizationId, name: 'Acme', role: 'owner' },
          }),
        );
      if (!req.url?.startsWith('/v2/invitations')) {
        res.statusCode = 404;
        return void res.end('{}');
      }
      requests.push({ method: req.method ?? '', url: req.url, body });
      if (req.method === 'GET') return void res.end(JSON.stringify([invitation]));
      if (req.method === 'POST' && req.url === '/v2/invitations') {
        const sent = JSON.parse(body) as { invitations: { email: string }[] };
        if (sent.invitations.some((entry) => entry.email === 'member@example.com')) {
          res.statusCode = 400;
          return void res.end(
            JSON.stringify({ statusCode: 400, message: 'Already a member: member@example.com' }),
          );
        }
        if (sent.invitations.some((entry) => entry.email === 'bounce@example.com')) {
          res.statusCode = 500;
          return void res.end(
            JSON.stringify({
              statusCode: 500,
              error: 'Internal Server Error',
              message: "Couldn't send invitations to bounce@example.com. The others were sent.",
              sentEmails: ['new.person@example.com'],
              failedEmails: ['bounce@example.com'],
            }),
          );
        }
        res.statusCode = 201;
        return void res.end(JSON.stringify([invitation]));
      }
      res.statusCode = 204;
      res.end();
    }),
  );
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  cleanups.push(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  return {
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    requests,
  };
}

async function connect(server: McpServer, clientName: string) {
  const client = new Client({ name: clientName, version: 'invitations-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function hosted(clientName: string) {
  const { baseUrl, requests } = await api();
  const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
  const client = await connect(factory.createServer(), clientName);
  const call = (name: string, args: Record<string, unknown>) =>
    runWithAuth('invite-user', clientName, () => client.callTool({ name, arguments: args }));
  return { client, call, requests };
}

async function local(toolsets?: Toolset[]) {
  const { baseUrl } = await api();
  const server = await createSyncMcpServer({
    apiKey: 'key',
    baseUrl,
    transport: 'stdio',
    port: 0,
    toolsets,
  });
  return connect(server, 'claude-code');
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { type: string; text: string }[])[0]!.text;

const invitationTools = async (client: Client) =>
  (await client.listTools()).tools
    .filter((tool) => tool.name.startsWith('invitations_'))
    .sort((a, b) => a.name.localeCompare(b.name));

describe('team invitation tools', () => {
  it.each(['claude-ai', 'claude-code', 'cursor', 'openai-mcp', 'openai-mcp (Codex)'])(
    'lists them on the hosted server to %s',
    async (name) => {
      const { client } = await hosted(name);
      const tools = await invitationTools(client);
      expect(tools.map((tool) => tool.name)).toEqual(INVITATION_TOOLS);
      const create = tools.find((tool) => tool.name === 'invitations_create')!;
      expect(create.title).toBe('invite people to the team');
      expect(create.description).toContain('confirm the addresses, roles and organization');
      expect(create.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tools.find((tool) => tool.name === 'invitations_list')!.annotations).toMatchObject({
        readOnlyHint: true,
      });
    },
  );

  it('sends invites, lists, resends and cancels through the API', async () => {
    const { call, requests } = await hosted('claude-ai');
    const invites = [{ email: 'new.person@example.com', role: 'member' }];
    const created = await call('invitations_create', { invitations: invites });
    expect(created.isError).not.toBe(true);
    expect(JSON.parse(text(created))).toMatchObject([{ id: INVITATION_ID, status: 'pending' }]);

    const listed = await call('invitations_list', { status: 'pending' });
    expect(listed.isError).not.toBe(true);
    expect(await call('invitations_resend', { id: INVITATION_ID })).not.toHaveProperty(
      'isError',
      true,
    );
    expect(await call('invitations_delete', { id: INVITATION_ID })).not.toHaveProperty(
      'isError',
      true,
    );

    expect(requests).toEqual([
      { method: 'POST', url: '/v2/invitations', body: JSON.stringify({ invitations: invites }) },
      { method: 'GET', url: '/v2/invitations?status=pending', body: '' },
      { method: 'POST', url: `/v2/invitations/${INVITATION_ID}/resend`, body: '' },
      { method: 'DELETE', url: `/v2/invitations/${INVITATION_ID}`, body: '' },
    ]);
  });

  it('passes on the API refusal that names an existing member', async () => {
    const { call } = await hosted('claude-ai');
    const refused = await call('invitations_create', {
      invitations: [
        { email: 'new.person@example.com', role: 'member' },
        { email: 'member@example.com', role: 'admin' },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('Already a member: member@example.com');
  });

  it('says to invite failed addresses again, and once, after a partial send', async () => {
    const { client, call, requests } = await hosted('claude-ai');
    const tools = await invitationTools(client);
    const descriptionOf = (name: string) => tools.find((tool) => tool.name === name)!.description;
    expect(descriptionOf('invitations_create')).toContain(
      'The failed addresses have no invitation, so call invitations_create again with only them, not invitations_resend.',
    );
    const partial = await call('invitations_create', {
      invitations: [
        { email: 'new.person@example.com', role: 'member' },
        { email: 'bounce@example.com', role: 'member' },
      ],
    });
    expect(partial.isError).toBe(true);
    expect(text(partial)).toContain("Couldn't send invitations to bounce@example.com");
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('tells the agent a resend keeps the stored role', async () => {
    const { client } = await hosted('claude-ai');
    const tools = await invitationTools(client);
    const descriptionOf = (name: string) => tools.find((tool) => tool.name === name)!.description;
    expect(descriptionOf('invitations_resend')).toContain(
      "It keeps the invitation's role: read the role with invitations_list and name it when confirming with the user. To change the role, cancel with invitations_delete and invite again with invitations_create.",
    );
    expect(descriptionOf('invitations_create')).toContain(
      'resend with invitations_resend when it is the role the user asked for, otherwise cancel with invitations_delete and invite again.',
    );
  });

  it('lists them locally only with the admin toolset', async () => {
    expect(await invitationTools(await local())).toEqual([]);
    expect(await invitationTools(await local(['lipsync', 'projects']))).toEqual([]);
    expect((await invitationTools(await local(['default', 'admin']))).map((t) => t.name)).toEqual(
      INVITATION_TOOLS,
    );
    expect((await invitationTools(await local(['all']))).map((t) => t.name)).toEqual(
      INVITATION_TOOLS,
    );
  });
});
