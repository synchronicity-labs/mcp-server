import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';
import { asyncRequestListener } from './test-fixtures/request-listener.js';
import { translationSpec } from './test-fixtures/translation.js';

// jobs_create-many and jobs_get-many end to end: dubbing_create fanned out over a stub API
// that enforces a concurrency limit, then the set read back with mixed statuses.
const videoAssetId = '00000000-0000-4000-8000-000000000002';
const setKey = '6f1f8c63-41a4-4f55-9d4e-2f7c1f7b1f10';
const spec = {
  ...translationSpec,
  paths: {
    ...translationSpec.paths,
    '/v2/generate/{id}': {
      get: {
        operationId: 'GenerateController_getGeneration',
        tags: ['Generate'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  },
};
const STATUS: Record<string, string> = {
  'g-es': 'COMPLETED',
  'g-fr': 'PROCESSING',
  'g-ja': 'FAILED',
};

type Body = { id?: string; dubParams?: { targetLang: string } };
type Created = {
  summary: Record<string, number>;
  items: { status: string; id?: string; error?: Record<string, unknown> }[];
  jobs: { kind: string; id: string }[];
};
type Read = { jobs: { id: string; status?: string }[]; counts: Record<string, number> };
type Submission = { lang: string; key?: string; status: number };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

/** POST /v2/generate admits CONCURRENCY at once and answers 429 above it, as the API does. */
async function api() {
  const CONCURRENCY = 2;
  const submissions: Submission[] = [];
  const projects: string[] = [];
  let running = 0;
  let peak = 0;
  // A generation started elsewhere holds one slot until the first refusal.
  let external = 1;
  const server = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') return void res.end(JSON.stringify(spec));
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? (JSON.parse(raw) as Body) : {};
      if (req.url === '/v2/account')
        return void res.end(
          JSON.stringify({ limits: { concurrency: CONCURRENCY, maxOutputDurationSeconds: 600 } }),
        );
      if (req.url === '/v2/projects' && req.method === 'POST') {
        projects.push(body.id!);
        return void res.end(JSON.stringify({ id: body.id }));
      }
      if (req.url === '/v2/generate' && req.method === 'POST')
        return submit(body, req.headers, res);
      const id = req.url?.match(/^\/v2\/generate\/([^/?]+)/)?.[1];
      if (id && STATUS[id]) return void res.end(JSON.stringify({ id, status: STATUS[id] }));
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'not found' }));
    }),
  );
  async function submit(
    body: Body,
    headers: IncomingHttpHeaders,
    res: import('node:http').ServerResponse,
  ) {
    const lang = body.dubParams!.targetLang;
    const key = headers['idempotency-key'] as string | undefined;
    if (running + external >= CONCURRENCY) {
      external = 0;
      submissions.push({ lang, key, status: 429 });
      res.statusCode = 429;
      res.setHeader('Retry-After', '0');
      return void res.end(
        JSON.stringify({ errorCode: 'concurrency_limit_reached', message: 'At your limit' }),
      );
    }
    running += 1;
    peak = Math.max(peak, running + external);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
    submissions.push({ lang, key, status: 201 });
    res.end(JSON.stringify({ id: `g-${lang}`, status: 'PENDING' }));
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    submissions,
    projects,
    peak: () => peak,
  };
}

async function connect(server: McpServer, name = 'claude-code') {
  cleanups.push(() => server.close());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name, version: '1.0.0' });
  cleanups.push(() => client.close());
  await client.connect(ct);
  return client;
}

const dub = (targetLang: string) => ({ videoAssetId, targetLang, model: 'sync-3' });

describe('jobs_create-many over stdio', () => {
  it('starts every item within the concurrency limit, retrying 429s with the same key', async () => {
    const { baseUrl, submissions, projects, peak } = await api();
    const client = await connect(
      await createSyncMcpServer({ apiKey: 'key', baseUrl, transport: 'stdio', port: 0 }),
    );
    const call = () =>
      client.callTool({
        name: 'jobs_create-many',
        arguments: {
          tool: 'dubbing_create',
          idempotencyKey: setKey,
          items: ['es', 'fr', 'ja'].map(dub),
        },
      });
    const result = await call();
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const content = result.structuredContent as Created;
    expect(content.summary).toEqual({ total: 3, started: 3, failed: 0, notStarted: 0 });
    expect(content.jobs).toEqual([
      { kind: 'generation', id: 'g-es' },
      { kind: 'generation', id: 'g-fr' },
      { kind: 'generation', id: 'g-ja' },
    ]);
    expect(peak()).toBeLessThanOrEqual(2);
    // Each language was admitted once, under its own key; refused attempts reused that key.
    const accepted = submissions.filter((submission) => submission.status === 201);
    expect(accepted.map((submission) => submission.lang).sort()).toEqual(['es', 'fr', 'ja']);
    expect(new Set(accepted.map((submission) => submission.key)).size).toBe(3);
    const refused = submissions.filter((submission) => submission.status === 429);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.key).toBe(accepted.find((entry) => entry.lang === refused[0]!.lang)!.key);
    // Each item got its own new project, keyed so a repeat names the same one.
    expect(new Set(projects).size).toBe(3);

    // Calling again with the same set key resends the same keys and projects.
    const keys = new Map(accepted.map((submission) => [submission.lang, submission.key]));
    await call();
    for (const submission of submissions.slice(accepted.length + 1))
      expect(submission.key).toBe(keys.get(submission.lang));
    expect(new Set(projects).size).toBe(3);
  });

  it('runs each item through the tool’s own checks, so one bad item fails alone', async () => {
    const { baseUrl, submissions } = await api();
    const client = await connect(
      await createSyncMcpServer({ apiKey: 'key', baseUrl, transport: 'stdio', port: 0 }),
    );
    const result = await client.callTool({
      name: 'jobs_create-many',
      arguments: {
        tool: 'dubbing_create',
        idempotencyKey: setKey,
        // An existing project without projectIntent is refused, as it is for a direct call.
        items: [dub('es'), { ...dub('fr'), projectId: '00000000-0000-4000-8000-000000000009' }],
      },
    });
    const content = result.structuredContent as Created;
    expect(content.items[0]).toMatchObject({ status: 'started', id: 'g-es' });
    expect(content.items[1]).toMatchObject({
      status: 'failed',
      error: { status: 400, code: 'PROJECT_INTENT_REQUIRED' },
    });
    expect(submissions.map((submission) => submission.lang)).toEqual(['es']);
  });

  it('refuses a tool that does not start a job, naming the ones it runs', async () => {
    const { baseUrl, submissions } = await api();
    const client = await connect(
      await createSyncMcpServer({ apiKey: 'key', baseUrl, transport: 'stdio', port: 0 }),
    );
    const result = await client.callTool({
      name: 'jobs_create-many',
      arguments: { tool: 'batches_create', idempotencyKey: setKey, items: [{}, { a: 1 }] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain('dubbing_create');
    expect(text).toContain('lipsync_create');
    expect(submissions).toEqual([]);
  });
});

describe('jobs_get-many', () => {
  it('reads a set with mixed statuses and counts them', async () => {
    const { baseUrl } = await api();
    const client = await connect(
      await createSyncMcpServer({ apiKey: 'key', baseUrl, transport: 'stdio', port: 0 }),
    );
    const result = await client.callTool({
      name: 'jobs_get-many',
      arguments: {
        jobs: ['g-es', 'g-fr', 'g-ja', 'g-gone'].map((id) => ({ kind: 'generation', id })),
      },
    });
    const content = result.structuredContent as Read;
    expect(content.jobs.map((job) => job.status)).toEqual([
      'COMPLETED',
      'PROCESSING',
      'FAILED',
      undefined,
    ]);
    expect(content.jobs[3]).toMatchObject({ id: 'g-gone', error: { status: 404 } });
    expect(content.counts).toEqual({
      total: 4,
      running: 1,
      completed: 1,
      failed: 1,
      unreadable: 1,
    });
  });
});

describe('hosted server', () => {
  it('lists both tools to agent clients, runs a set, and keeps them out of the ChatGPT app', async () => {
    const { baseUrl, submissions } = await api();
    const factory = await createMcpServerFactory({ baseUrl, transport: 'http', port: 0 });
    const claude = await connect(factory.createServer('claude-code'), 'claude-code');
    const names = (await claude.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['jobs_create-many', 'jobs_get-many']));
    const result = await claude.callTool({
      name: 'jobs_create-many',
      arguments: { tool: 'dubbing_create', idempotencyKey: setKey, items: ['es', 'ja'].map(dub) },
    });
    expect((result.structuredContent as Created).summary).toMatchObject({ started: 2 });
    expect(submissions.filter((submission) => submission.status === 201)).toHaveLength(2);
    const chatgpt = await connect(factory.createServer('openai-mcp'), 'openai-mcp');
    const listed = (await chatgpt.listTools()).tools.map((tool) => tool.name);
    expect(listed).not.toContain('jobs_create-many');
    expect(listed).not.toContain('jobs_get-many');
  });
});
