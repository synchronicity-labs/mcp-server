import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';
import { translationInput, translationSpec } from './test-fixtures/translation.js';

const existingId = '00000000-0000-4000-8000-000000000010';
const projectSpec = {
  ...translationSpec,
  paths: {
    ...translationSpec.paths,
    '/v2/projects': {
      post: {
        operationId: 'ProjectsController_create',
        tags: ['Projects'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { id: { type: 'string' }, name: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
};
const newId = '00000000-0000-4000-8000-000000000011';
const secondId = '00000000-0000-4000-8000-000000000012';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (let close = cleanup.pop(); close; close = cleanup.pop()) await close();
});

async function fixture() {
  const original = {
    id: existingId,
    name: 'Translate and Dub',
    draft: 'Original video and language',
  };
  const projects = new Map([[existingId, { ...original }]]);
  const generations: Record<string, unknown>[] = [];
  const calls: Array<{
    method?: string;
    path?: string;
    body: Record<string, unknown>;
    key?: string;
  }> = [];
  const acceptedKeys = new Map<string, string>();
  let loseResponse = false;
  const generate = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => {
    const key = req.headers['idempotency-key'] as string | undefined;
    if (key && acceptedKeys.has(key) && acceptedKeys.get(key) !== JSON.stringify(body))
      return void res.writeHead(409).end(JSON.stringify({ message: 'Idempotency conflict' }));
    if (!key || !acceptedKeys.has(key)) generations.push(body);
    if (key) acceptedKeys.set(key, JSON.stringify(body));
    if (loseResponse) {
      loseResponse = false;
      return req.socket.destroy();
    }
    return void res.end(JSON.stringify({ id: newId, status: 'PENDING' }));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api-json') return void res.end(JSON.stringify(projectSpec));
    let text = '';
    for await (const chunk of req) text += chunk.toString();
    const body = text ? JSON.parse(text) : {};
    calls.push({
      method: req.method,
      path: req.url,
      body,
      key: req.headers['idempotency-key'] as string | undefined,
    });
    if (req.method === 'POST' && req.url === '/v2/projects') {
      const id = body.id ?? newId;
      if (!projects.has(id)) projects.set(id, { id, name: body.name, draft: '' });
      return void res.end(JSON.stringify(projects.get(id)));
    }
    if (req.url?.startsWith('/v2/projects/')) {
      const project = projects.get(req.url.split('/').at(-1)!);
      res.statusCode = project ? 200 : 404;
      return void res.end(JSON.stringify(project ?? {}));
    }
    if (req.method === 'GET' && req.url?.startsWith('/v2/projects'))
      return void res.end(JSON.stringify({ items: [...projects.values()] }));
    if (req.url === '/v2/generate') return generate(req, res, body);
    res.writeHead(404).end('{}');
  };
  const upstream = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  cleanup.push(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${address.port}`,
    transport: 'http',
    port: 0,
  });
  const server = factory.createServer();
  cleanup.push(() => server.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  cleanup.push(() => client.close());
  await client.connect(clientTransport);
  return {
    projects,
    original,
    calls,
    generations,
    loseNextResponse: () => {
      loseResponse = true;
    },
    call: (name: string, args: Record<string, unknown>, token = 'user-token') =>
      runWithAuth(token, 'openai-mcp', () => client.callTool({ name, arguments: args })),
  };
}

it('starts fresh Spanish translation of an imported YouTube video despite an existing Translate and Dub project', async () => {
  const { call, projects, original, generations, calls } = await fixture();
  const { projectId: _projectId, ...input } = translationInput;
  const result = await call('create-translate-and-dub', {
    ...input,
    projectName: 'Translate and Dub',
    projectCreationKey: newId,
  });
  expect(result.isError).not.toBe(true);
  expect(projects.get(existingId)).toEqual(original);
  const createdId = [...projects.keys()].find((id) => id !== existingId)!;
  expect(projects.get(createdId)?.name).toBe('Translate and Dub');
  expect(
    calls.find((request) => request.method === 'POST' && request.path === '/v2/projects')?.body
      .defaultWorkflow,
  ).toBe('translate_and_dub');
  expect(generations).toEqual([
    expect.objectContaining({
      projectId: createdId,
      dubParams: { targetLang: 'es', sourceLang: 'auto' },
    }),
  ]);
  expect(
    calls.some((request) => request.method === 'GET' && request.path?.startsWith('/v2/projects')),
  ).toBe(false);
});

it('creates separate projects for repeated workflow names instead of resolving by name', async () => {
  const { call, projects, original, generations } = await fixture();
  for (const [index, id] of [newId, secondId].entries()) {
    const result = await call('create-lipsync', {
      videoAssetId: translationInput.videoAssetId,
      audioAssetId: secondId,
      projectName: 'Translate and Dub',
      projectCreationKey: id,
      idempotencyKey: `new-${index}`,
    });
    expect(result.isError).not.toBe(true);
  }
  expect(projects.size).toBe(3);
  expect(projects.get(existingId)).toEqual(original);
  expect(new Set(generations.map((item) => item.projectId)).size).toBe(2);
  expect(generations.every((item) => item.projectId !== existingId)).toBe(true);
});

it.each(['create-lipsync', 'create-translate-and-dub'])(
  'refuses an inferred existing project before any upstream work: %s',
  async (name) => {
    const { call, calls, projects, original } = await fixture();
    const result = await call(name, {
      ...(name === 'create-lipsync'
        ? { videoAssetId: newId, audioAssetId: secondId }
        : translationInput),
      projectId: existingId,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: 'PROJECT_INTENT_REQUIRED' } });
    expect(calls).toEqual([]);
    expect(projects.get(existingId)).toEqual(original);
  },
);

it('honors an explicit update to the selected existing project without creating another project', async () => {
  const { call, projects, generations } = await fixture();
  const result = await call('create-translate-and-dub', {
    ...translationInput,
    projectId: existingId,
    projectIntent: 'explicit',
  });
  expect(result.isError).not.toBe(true);
  expect(projects.size).toBe(1);
  expect(generations).toEqual([expect.objectContaining({ projectId: existingId })]);
  expect(generations[0]).not.toHaveProperty('projectIntent');
});

it('retains project identity after a lost generation response without name reuse', async () => {
  const { call, projects, generations, loseNextResponse, calls } = await fixture();
  const { projectId: _projectId, ...input } = translationInput;
  const args = { ...input, projectCreationKey: newId, projectName: 'Translate and Dub' };
  loseNextResponse();
  expect((await call('create-translate-and-dub', args)).isError).toBe(true);
  expect((await call('create-translate-and-dub', args)).isError).not.toBe(true);
  expect(projects.size).toBe(2);
  expect(generations).toHaveLength(1);
  expect(generations[0]?.projectId).not.toBe(existingId);
  const writes = calls.filter((request) => request.path === '/v2/generate');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

it('does not interpret an old project UUID as the destination of a new creation', async () => {
  const { call, projects, original, generations } = await fixture();
  const { projectId: _projectId, ...input } = translationInput;
  const result = await call('create-translate-and-dub', {
    ...input,
    projectCreationKey: existingId,
    projectName: 'Translate and Dub',
  });
  expect(result.isError).not.toBe(true);
  expect(projects.size).toBe(2);
  expect(projects.get(existingId)).toEqual(original);
  expect(generations[0]?.projectId).not.toBe(existingId);
});

it('accepts a project this connection just created without projectIntent, including a retry', async () => {
  const { call, generations, loseNextResponse } = await fixture();
  const created = await call('projects_create', { id: secondId, name: 'Talking Owl' });
  expect(created.isError).not.toBe(true);
  const args = {
    videoAssetId: translationInput.videoAssetId,
    audioAssetId: newId,
    projectId: secondId,
    idempotencyKey: 'owl-1',
  };
  loseNextResponse();
  expect((await call('create-lipsync', args)).isError).toBe(true);
  expect((await call('create-lipsync', args)).isError).not.toBe(true);
  expect(generations).toEqual([expect.objectContaining({ projectId: secondId })]);
});

it('refuses a project another connection created', async () => {
  const { call, calls } = await fixture();
  const otherId = '00000000-0000-4000-8000-000000000013';
  await call('projects_create', { id: otherId, name: 'Talking Owl' }, 'other-token');
  const writes = calls.length;
  const result = await call('create-lipsync', {
    videoAssetId: translationInput.videoAssetId,
    audioAssetId: newId,
    projectId: otherId,
  });
  expect(result.structuredContent).toMatchObject({ error: { code: 'PROJECT_INTENT_REQUIRED' } });
  expect(calls).toHaveLength(writes);
});

it('creates a new project for a keyed request that has no projectCreationKey', async () => {
  const { call, projects, original, generations } = await fixture();
  const result = await call('create-lipsync', {
    videoAssetId: translationInput.videoAssetId,
    audioAssetId: secondId,
    idempotencyKey: 'legacy-keyed-request',
  });
  expect(result.isError).not.toBe(true);
  expect(projects.size).toBe(2);
  expect(projects.get(existingId)).toEqual(original);
  expect(generations).toEqual([expect.objectContaining({ projectId: newId })]);
});
