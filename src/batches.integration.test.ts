import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { SyncMcpConfig } from './config.js';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';
import {
  type BatchApiCall as Call,
  type BatchApiReply as Reply,
  batchItems as items,
  batchPayload as payload,
  startBatchApi,
} from './test-fixtures/batch-api.js';
import type { Toolset } from './toolsets.js';

// batches_create, batches_get, batches_list and jobs kind batch, on a stub API.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0);
  while (pending.length > 0) await pending.pop()!();
});

async function api(createReply?: Reply) {
  const { calls, baseUrl, close } = await startBatchApi(createReply);
  cleanups.push(close);
  return { calls, baseUrl };
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

async function stdio(options: { reply?: Reply; toolsets?: Toolset[]; spend?: boolean } = {}) {
  const { baseUrl, calls } = await api(options.reply);
  const config: SyncMcpConfig = {
    apiKey: 'key',
    baseUrl,
    transport: 'stdio',
    port: 0,
    toolsets: options.toolsets,
    ...(options.spend === false ? { spendConfirmation: false } : {}),
  };
  const client = await connect(await createSyncMcpServer(config));
  return { client, calls };
}

const batchCalls = (calls: Call[]) => calls.filter((call) => call.url.startsWith('/v2/batch'));
// Other local processes sometimes probe open ports; count only the routes the tools use.
const apiUrls = (calls: Call[]) =>
  calls.map((call) => call.url).filter((url) => /^\/(?:v2|signed)\//.test(url));

describe('batches_create', () => {
  it('builds /v2/generate rows, generating the missing requestIds', async () => {
    const { client, calls } = await stdio();
    const list = items(20);
    list[0] = { ...list[0]!, requestId: 'item-2' } as (typeof list)[number];
    const result = await client.callTool({
      name: 'batches_create',
      arguments: { items: list, webhookUrl: 'https://hooks.test/batch' },
    });
    expect(result.isError).not.toBe(true);
    const ids = (result.structuredContent as { requestIds: string[] }).requestIds;
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('item-2');
    // The generated id for the second item would repeat the first, so it gets a suffix.
    expect(ids[1]).toMatch(/^item-2-[0-9a-f]{8}$/);
    expect(ids[19]).toBe('item-20');
    expect(new Set(ids).size).toBe(20);
    expect(result.structuredContent).toMatchObject({ id: 'b-1', status: 'PENDING' });
    const [create] = batchCalls(calls);
    expect(create).toMatchObject({ method: 'POST', url: '/v2/batch' });
    expect(create!.body).toEqual({
      rows: list.map((entry, index) => ({
        request_id: ids[index],
        endpoint: '/v2/generate',
        payload: entry.payload,
      })),
      webhook_url: 'https://hooks.test/batch',
    });
  });

  it('sends dry_run and returns VALIDATED', async () => {
    const { client, calls } = await stdio({
      reply: { status: 200, body: { status: 'VALIDATED' } },
    });
    const result = await client.callTool({
      name: 'batches_create',
      arguments: { items: items(20), dryRun: true },
    });
    expect(result.structuredContent).toMatchObject({ status: 'VALIDATED' });
    expect(batchCalls(calls)[0]!.body).toMatchObject({ dry_run: true });
  });

  it('names each bad item and sends nothing', async () => {
    const { client, calls } = await stdio();
    const list: unknown[] = items(22);
    list[3] = { requestId: 'same', payload: payload(3) };
    list[7] = { requestId: 'same', payload: payload(7) };
    list[9] = { payload: { input: payload(9).input } };
    list[12] = { payload: { model: 'sync-3', input: [{ url: 'https://cdn.test/x.mp4' }] } };
    list[15] = { payload: { model: 'sync-3', input: [] } };
    const result = await client.callTool({ name: 'batches_create', arguments: { items: list } });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain('items[7].requestId "same" repeats items[3]');
    expect(text).toContain('items[9]: payload.model');
    expect(text).toContain('items[12]: payload.input[0] needs a type');
    expect(text).toContain('items[15]: payload.input must list the inputs');
    expect(batchCalls(calls)).toEqual([]);
  });

  it('requires projectIntent=explicit before any item writes into an existing project', async () => {
    const { client, calls } = await stdio();
    const list = items(20).map((entry, index) =>
      index === 2 || index === 5
        ? { payload: { ...entry.payload, projectId: 'existing-project' } }
        : entry,
    );
    const refused = await client.callTool({ name: 'batches_create', arguments: { items: list } });
    expect(refused.isError).toBe(true);
    const { error } = refused.structuredContent as { error: Record<string, unknown> };
    expect(error).toMatchObject({ status: 400, code: 'PROJECT_INTENT_REQUIRED' });
    expect(error.message).toContain('items[2], items[5] set payload.projectId');
    expect(batchCalls(calls)).toEqual([]);

    const allowed = await client.callTool({
      name: 'batches_create',
      arguments: { items: list, projectIntent: 'explicit' },
    });
    expect(allowed.isError).not.toBe(true);
    const [create] = batchCalls(calls);
    // projectIntent is this server's guard, not an API field.
    expect(create!.body).not.toHaveProperty('projectIntent');
    expect((create!.body as { rows: { payload: unknown }[] }).rows[2]!.payload).toMatchObject({
      projectId: 'existing-project',
    });
  });

  it('refuses fewer than 20 items and batches over 5 MB before calling the API', async () => {
    const { client, calls } = await stdio();
    const few = await client.callTool({ name: 'batches_create', arguments: { items: items(19) } });
    expect(few.isError).toBe(true);
    expect(JSON.stringify(few.content)).toContain('at least 20 items');
    const big = items(20).map((entry) => ({
      payload: { ...entry.payload, options: { padding: 'x'.repeat(300_000) } },
    }));
    const huge = await client.callTool({ name: 'batches_create', arguments: { items: big } });
    expect(huge.isError).toBe(true);
    expect(JSON.stringify(huge.content)).toContain('at most 5 MB');
    expect(batchCalls(calls)).toEqual([]);
  });

  it('surfaces a 402 plan refusal with requiredPlan, billingUrl and what to do instead', async () => {
    const { client } = await stdio({
      reply: {
        status: 402,
        body: {
          statusCode: 402,
          errorCode: 'plan_feature_unavailable',
          message: 'Batch requires the scale plan or above.',
          requiredPlan: 'scale',
          billingUrl: 'https://sync.so/billing',
        },
      },
    });
    const result = await client.callTool({
      name: 'batches_create',
      arguments: { items: items(20) },
    });
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as { error: Record<string, unknown> };
    expect(error).toMatchObject({
      status: 402,
      code: 'plan_feature_unavailable',
      requiredPlan: 'scale',
      billingUrl: 'https://sync.so/billing',
    });
    expect(error.message).toContain('Batch requires the scale plan or above.');
    expect(error.nextStep).toContain('It needs the scale plan or above.');
    expect(error.nextStep).toContain('lipsync_create');
  });

  it('explains the batch concurrency limit rather than a running generation', async () => {
    const { client } = await stdio({
      reply: {
        status: 429,
        body: {
          errorCode: 'concurrency_limit_reached',
          message: 'Batch concurrency limit reached.',
          activeBatches: 3,
          concurrencyLimit: 3,
          retryAfterSeconds: 20,
        },
      },
    });
    const result = await client.callTool({
      name: 'batches_create',
      arguments: { items: items(20) },
    });
    const { error } = result.structuredContent as { error: Record<string, unknown> };
    expect(error).toMatchObject({ status: 429, activeBatches: 3, concurrencyLimit: 3 });
    expect(error.nextStep).toContain('batches_list');
    expect(error.nextStep).not.toContain('generations_get');
  });

  it('maps an API line number to the item', async () => {
    const { client } = await stdio({
      reply: { status: 400, body: { message: 'line 5: invalid payload', lineNumber: 5 } },
    });
    const result = await client.callTool({
      name: 'batches_create',
      arguments: { items: items(20) },
    });
    const { error } = result.structuredContent as { error: Record<string, unknown> };
    expect(error).toMatchObject({ lineNumber: 5 });
    expect(error.nextStep).toContain('Line 5 is items[4].');
  });

  it('keeps the dryRun advice but drops confirmation prose when spend confirmation is off', async () => {
    const description = async (spend?: boolean) =>
      (await (await stdio({ spend })).client.listTools()).tools.find(
        (tool) => tool.name === 'batches_create',
      )!.description!;
    const attended = await description();
    const unattended = await description(false);
    expect(attended).toContain('wait for their confirmation');
    expect(unattended).not.toMatch(/confirmation|estimate a representative/);
    expect(unattended).toContain('dryRun: true');
    expect(unattended).toContain('Every item is billed as its own generation.');
  });
});

describe('batches_get and jobs_wait', () => {
  it('waits until the batch completes, then lists each item from the result file', async () => {
    const { client, calls } = await stdio();
    const progress: { progress: number; message?: string }[] = [];
    const result = await client.callTool(
      { name: 'batches_get', arguments: { id: 'b-1', wait: true } },
      { onprogress: (update) => void progress.push(update) },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      id: 'b-1',
      status: 'COMPLETED',
      metrics: { total_generations: 20, success_count: 19, failed_count: 1 },
      results: [
        {
          requestId: 'item-1',
          status: 'COMPLETED',
          generationId: 'g-1',
          outputMediaUrl: 'https://cdn.test/out1.mp4',
        },
        { requestId: 'item-2', status: 'FAILED', error: { code: 'INVALID_INPUT' } },
      ],
    });
    expect(progress).toEqual([
      expect.objectContaining({ progress: 1, message: 'batch jobs_created 25%' }),
    ]);
    expect(apiUrls(calls)).toEqual([
      '/v2/batch/b-1',
      '/v2/batch/b-1',
      '/v2/batches/b-1/result',
      '/signed/out.jsonl',
    ]);
    // The result file is public; it is fetched without the account's credentials.
    expect(
      calls
        .filter((call) => ['/v2/batches/b-1/result', '/signed/out.jsonl'].includes(call.url))
        .map((call) => call.authorized),
    ).toEqual([false, false]);
  });

  it('returns only failed rows, or none, when asked', async () => {
    const { client } = await stdio();
    await client.callTool({ name: 'batches_get', arguments: { id: 'b-1' } });
    const failed = await client.callTool({
      name: 'batches_get',
      arguments: { id: 'b-1', results: 'failed' },
    });
    expect((failed.structuredContent as { results: unknown[] }).results).toEqual([
      expect.objectContaining({ requestId: 'item-2' }),
    ]);
    const none = await client.callTool({
      name: 'batches_get',
      arguments: { id: 'b-1', results: 'none' },
    });
    expect(none.structuredContent).not.toHaveProperty('results');
  });

  it('reads result files only from the API origin, and says how to get results otherwise', async () => {
    const { client, calls } = await stdio();
    const result = await client.callTool({ name: 'batches_get', arguments: { id: 'b-2' } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ id: 'b-2', status: 'FAILED' });
    expect(result.structuredContent).not.toHaveProperty('results');
    const { resultsError } = result.structuredContent as { resultsError: string };
    expect(resultsError).toContain('not on the Sync API');
    expect(resultsError).toContain('generations_list');
    expect(apiUrls(calls)).toEqual(['/v2/batch/b-2']);
  });

  it('stops reading a result file past the size cap, even without Content-Length', async () => {
    const { client } = await stdio();
    const result = await client.callTool({ name: 'batches_get', arguments: { id: 'b-3' } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ id: 'b-3', status: 'COMPLETED' });
    expect(result.structuredContent).not.toHaveProperty('results');
    expect((result.structuredContent as { resultsError: string }).resultsError).toContain(
      'too large to read here',
    );
  });

  it('waits on a batch through jobs_wait kind batch', async () => {
    const { client } = await stdio();
    const jobs = (await client.listTools()).tools.find((tool) => tool.name === 'jobs_wait');
    expect(jobs?.inputSchema.properties?.kind).toMatchObject({
      enum: expect.arrayContaining(['batch']),
    });
    const progress: string[] = [];
    const result = await client.callTool(
      { name: 'jobs_wait', arguments: { kind: 'batch', id: 'b-1' } },
      { onprogress: (update) => void progress.push(update.message ?? '') },
    );
    expect(result.structuredContent).toMatchObject({
      kind: 'batch',
      id: 'b-1',
      status: 'COMPLETED',
      result: {
        status: 'COMPLETED',
        results: [expect.objectContaining({ generationId: 'g-1' }), expect.anything()],
      },
    });
    expect(progress).toEqual(['batch processing 25%']);
  });

  it('lists batches with the API query names', async () => {
    const { client, calls } = await stdio();
    const result = await client.callTool({
      name: 'batches_list',
      arguments: { status: 'PROCESSING', createdAfter: '2026-11-01T00:00:00Z' },
    });
    expect(result.structuredContent).toEqual({ batches: [{ id: 'b-1', status: 'PROCESSING' }] });
    expect(batchCalls(calls)[0]!.url).toBe(
      '/v2/batch?status=PROCESSING&created_after=2026-11-01T00%3A00%3A00Z',
    );
  });
});

describe('batch tool listing', () => {
  const BATCH = ['batches_create', 'batches_get', 'batches_list'];

  async function hostedNames(clientName: string) {
    const { baseUrl } = await api();
    const config: SyncMcpConfig = { baseUrl, transport: 'http', port: 0 };
    const client = await connect((await createMcpServerFactory(config)).createServer(), clientName);
    return (await client.listTools()).tools.map((tool) => tool.name);
  }

  it.each(['claude-code', 'claude-ai', 'openai-mcp (Codex)', 'cursor-vscode'])(
    'lists the batch tools on the hosted server for %s',
    async (clientName) => {
      expect(await hostedNames(clientName)).toEqual(expect.arrayContaining(BATCH));
    },
  );

  it('keeps them out of the ChatGPT app listing', async () => {
    const names = await hostedNames('openai-mcp');
    for (const name of BATCH) expect(names).not.toContain(name);
    expect(names).not.toContain('batch_create-batch');
  });

  it.each<[Toolset[] | undefined, boolean]>([
    [undefined, true],
    [['lipsync'], true],
    [['dubbing'], true],
    [['assets'], false],
  ])('stdio toolsets %j list them: %s', async (toolsets, listed) => {
    const { client } = await stdio({ toolsets });
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const name of BATCH) expect(names.has(name), name).toBe(listed);
  });
});
