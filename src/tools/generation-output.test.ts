import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParsedOperation } from '../openapi/types.js';
import { registerTools } from '../server.js';
import { withGenerationOutputAliases } from './generation-output.js';
import { generateTools } from './generator.js';
import { getOverride } from './overrides.js';

const signedUrl = 'https://fixture.invalid/result.mp4?Signature=a%2Fb%2Bc&Expires=123';
const idParameter = { name: 'id', in: 'path' as const, required: true, schema: { type: 'string' } };
const operation = (operationId: string, path: string, parameters = [idParameter]) =>
  ({
    operationId,
    method: 'get',
    path,
    summary: '',
    tags: [],
    parameters,
    isMultipart: false,
  }) satisfies ParsedOperation;
const operations = [
  operation('GenerateController_getGeneration', '/v2/generate/{id}'),
  operation('GenerationsController_getById', '/v2/generations/{id}'),
  operation('GenerateController_getGenerations', '/v2/generations', []),
  operation('ModelsController_get', '/v2/models', []),
];
// /v2/generate answers with the API's Generation; /v2/generations/{id} with GenerationDto.
const responses: Record<string, unknown> = {
  '/v2/generate/done': { id: 'done', status: 'COMPLETED', model: 'sync-3', outputUrl: signedUrl },
  '/v2/generate/failed': { id: 'failed', status: 'FAILED', outputUrl: null },
  '/v2/generate/pending': { id: 'pending', status: 'PENDING' },
  '/v2/generations/dto': {
    id: 'dto',
    organizationId: 'private-org',
    status: 'COMPLETED',
    model: { id: 'model-1', name: 'sync-3' },
    modelName: 'sync-3',
    outputMediaUrl: signedUrl,
    outputMediaLength: 4.2,
    potentialError: null,
  },
  '/v2/generations': [
    { id: 'done', status: 'COMPLETED', outputUrl: signedUrl },
    { id: 'pending', status: 'PENDING' },
  ],
  '/v2/models': [{ name: 'sync-3' }],
};

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect() {
  const request = vi.fn(async (_method: string, path: string) => responses[path]);
  const tools = generateTools(operations, { request }).map(withGenerationOutputAliases);
  const server = new McpServer({ name: 'generation-output-test', version: '1' });
  registerTools(server, tools);
  const client = new Client({ name: 'claude-code', version: '1' });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, tools };
}

type Properties = Record<string, { deprecated?: boolean; description?: string }>;
function outputProperties(tool: { outputSchema?: Record<string, unknown> }): Properties {
  return (tool.outputSchema as { properties: Properties }).properties;
}

describe('generation results', () => {
  it('return the API name outputMediaUrl and the deprecated outputUrl with one value', async () => {
    const { client } = await connect();
    const done = await client.callTool({
      name: 'generate_get-generation',
      arguments: { id: 'done' },
    });
    expect(done.isError).not.toBe(true);
    expect(done.structuredContent).toEqual({
      id: 'done',
      status: 'COMPLETED',
      model: 'sync-3',
      outputMediaUrl: signedUrl,
      outputUrl: signedUrl,
    });
    const text = JSON.parse((done.content as Array<{ text: string }>)[0]!.text);
    expect([text.outputMediaUrl, text.outputUrl]).toEqual([signedUrl, signedUrl]);

    const failed = await client.callTool({
      name: 'generate_get-generation',
      arguments: { id: 'failed' },
    });
    expect(failed.structuredContent).toMatchObject({ outputMediaUrl: null, outputUrl: null });
    const pending = await client.callTool({
      name: 'generate_get-generation',
      arguments: { id: 'pending' },
    });
    expect(pending.structuredContent).toEqual({ id: 'pending', status: 'PENDING' });
  });

  it("keep GenerationDto's names and add the older ones on generations_get-by-id", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'generations_get-by-id',
      arguments: { id: 'dto' },
    });
    // GenerationDto.model is an object; the old string-only schema refused this result.
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      id: 'dto',
      status: 'COMPLETED',
      model: { id: 'model-1', name: 'sync-3' },
      modelName: 'sync-3',
      outputMediaUrl: signedUrl,
      outputUrl: signedUrl,
      outputMediaLength: 4.2,
      outputDuration: 4.2,
      potentialError: null,
    });
  });

  it('name each listed generation outputMediaUrl too', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'generate_get-generations', arguments: {} });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual([
      { id: 'done', status: 'COMPLETED', outputUrl: signedUrl, outputMediaUrl: signedUrl },
      { id: 'pending', status: 'PENDING' },
    ]);
  });

  it('leave tools without generation results unchanged', () => {
    const [models] = generateTools([operations[3]!], { request: vi.fn() });
    expect(withGenerationOutputAliases(models!)).toBe(models);
  });

  it('mark outputUrl deprecated in the output schema and point descriptions at outputMediaUrl', async () => {
    const { client } = await connect();
    const descriptors = (await client.listTools()).tools;
    const get = descriptors.find((tool) => tool.name === 'generate_get-generation')!;
    const byId = descriptors.find((tool) => tool.name === 'generations_get-by-id')!;
    for (const tool of [get, byId]) {
      const properties = outputProperties(tool);
      expect(properties.outputMediaUrl?.deprecated).toBeUndefined();
      expect(properties.outputMediaUrl?.description).toContain('verbatim');
      expect(properties.outputUrl?.deprecated).toBe(true);
      expect(properties.outputUrl?.description).toContain('Deprecated alias of outputMediaUrl');
    }
    expect(outputProperties(get).outputDuration?.deprecated).toBeUndefined();
    expect(outputProperties(byId).outputDuration?.deprecated).toBe(true);
    expect(outputProperties(byId).outputMediaLength?.deprecated).toBeUndefined();

    expect(get.description).toContain('copy the exact `structuredContent.outputMediaUrl` string');
    expect(get.description).toContain('`outputUrl` is a deprecated alias');
    expect(get.description).not.toContain('structuredContent.outputUrl');
    expect(byId.description).toContain('when COMPLETED, `outputMediaUrl`');
    expect(getOverride('generate_create-generation')?.description).toContain(
      'when completed, read `outputMediaUrl` (`outputUrl` is a deprecated alias)',
    );
  });
});
