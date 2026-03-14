import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import { generateTools, operationIdToToolName } from './generator.js';

describe('operationIdToToolName', () => {
  it('converts controller operation IDs to tool names', () => {
    expect(operationIdToToolName('GenerateController_createGeneration')).toBe(
      'generate_create-generation',
    );
    expect(operationIdToToolName('AssetsController_getAll')).toBe('assets_get-all');
    expect(operationIdToToolName('ModelsController_getPublic')).toBe('models_get-public');
  });

  it('kebab-cases multi-word controller names', () => {
    expect(operationIdToToolName('DeviceAuthController_start')).toBe('device-auth_start');
    expect(operationIdToToolName('AssetMetadataController_getAll')).toBe('asset-metadata_get-all');
  });

  it('handles single-part operation IDs', () => {
    expect(operationIdToToolName('createSomething')).toBe('create-something');
  });
});

describe('generateTools', () => {
  const mockHttpClient: HttpClient = {
    request: vi.fn().mockResolvedValue({ id: 'gen-123' }),
  };

  const operations: ParsedOperation[] = [
    {
      operationId: 'GenerateController_createGeneration',
      method: 'post',
      path: '/v2/generate',
      summary: 'Create a generation',
      tags: ['Generate'],
      parameters: [],
      requestBody: {
        schema: {
          type: 'object',
          properties: {
            model: { type: 'string' },
          },
          required: ['model'],
        },
        contentType: 'application/json',
      },
      isMultipart: false,
    },
    {
      operationId: 'GenerateController_getGeneration',
      method: 'get',
      path: '/v2/generate/{id}',
      summary: 'Get a generation by ID',
      tags: ['Generate'],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      isMultipart: false,
    },
  ];

  it('generates tools from operations', () => {
    const tools = generateTools(operations, mockHttpClient);
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe('generate_create-generation');
    expect(tools[1]?.name).toBe('generate_get-generation');
  });

  it('uses overrides for known tools', () => {
    const tools = generateTools(operations, mockHttpClient);
    expect(tools[0]?.description).toContain('lipsync video');
  });

  it('handler calls httpClient with correct params', async () => {
    const tools = generateTools(operations, mockHttpClient);

    await tools[0]?.handler({ model: 'sync-1.9.0-beta' });
    expect(mockHttpClient.request).toHaveBeenCalledWith('post', '/v2/generate', {
      query: undefined,
      body: { model: 'sync-1.9.0-beta' },
    });
  });

  it('handler substitutes path parameters', async () => {
    const tools = generateTools(operations, mockHttpClient);

    await tools[1]?.handler({ id: 'gen-456' });
    expect(mockHttpClient.request).toHaveBeenCalledWith('get', '/v2/generate/gen-456', {
      query: undefined,
      body: undefined,
    });
  });

  it('handler builds query parameters', async () => {
    const opWithQuery: ParsedOperation[] = [
      {
        operationId: 'AssetsController_getAll',
        method: 'get',
        path: '/v2/assets',
        summary: 'List assets',
        tags: ['Assets'],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'number' },
          },
        ],
        isMultipart: false,
      },
    ];

    const tools = generateTools(opWithQuery, mockHttpClient);
    await tools[0]?.handler({ limit: 10 });
    expect(mockHttpClient.request).toHaveBeenCalledWith('get', '/v2/assets', {
      query: { limit: '10' },
      body: undefined,
    });
  });

  it('handles allOf composed body schemas', async () => {
    const opWithAllOf: ParsedOperation[] = [
      {
        operationId: 'TestController_create',
        method: 'post',
        path: '/v2/test',
        summary: 'Test allOf',
        tags: ['Test'],
        parameters: [],
        requestBody: {
          schema: {
            allOf: [
              {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
              },
              {
                type: 'object',
                properties: { age: { type: 'number' } },
              },
            ],
          },
          contentType: 'application/json',
        },
        isMultipart: false,
      },
    ];

    const tools = generateTools(opWithAllOf, mockHttpClient);
    await tools[0]?.handler({ name: 'test', age: 25 });
    expect(mockHttpClient.request).toHaveBeenCalledWith('post', '/v2/test', {
      query: undefined,
      body: { name: 'test', age: 25 },
    });
  });

  it('handles schema with both properties and allOf', async () => {
    const opWithBoth: ParsedOperation[] = [
      {
        operationId: 'TestController_mixed',
        method: 'post',
        path: '/v2/mixed',
        summary: 'Test mixed',
        tags: ['Test'],
        parameters: [],
        requestBody: {
          schema: {
            type: 'object',
            properties: { base: { type: 'string' } },
            required: ['base'],
            allOf: [
              {
                type: 'object',
                properties: { extra: { type: 'number' } },
              },
            ],
          },
          contentType: 'application/json',
        },
        isMultipart: false,
      },
    ];

    const tools = generateTools(opWithBoth, mockHttpClient);
    await tools[0]?.handler({ base: 'hello', extra: 42 });
    expect(mockHttpClient.request).toHaveBeenCalledWith('post', '/v2/mixed', {
      query: undefined,
      body: { base: 'hello', extra: 42 },
    });
  });
});
