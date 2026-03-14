import { describe, expect, it } from 'vitest';
import { parseSpec, resolveRef, resolveSchemaRefs } from './parser.js';
import type { OpenApiSpec } from './types.js';

const MINIMAL_SPEC: OpenApiSpec = {
  openapi: '3.1.0',
  paths: {
    '/v2/generate': {
      post: {
        operationId: 'GenerateController_createGeneration',
        summary: 'Create a generation',
        tags: ['Generate'],
        parameters: [],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  model: { type: 'string' },
                  input: { type: 'array', items: { type: 'object' } },
                },
                required: ['model', 'input'],
              },
            },
          },
        },
      },
    },
    '/v2/generate/{id}': {
      get: {
        operationId: 'GenerateController_getGeneration',
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
      },
    },
    '/v2/internal/something': {
      get: {
        operationId: 'InternalController_doSomething',
        summary: 'Internal endpoint',
        tags: ['internal'],
        parameters: [],
      },
    },
  },
};

describe('parseSpec', () => {
  it('parses operations from OpenAPI spec', () => {
    const operations = parseSpec(MINIMAL_SPEC);
    expect(operations).toHaveLength(2);
  });

  it('extracts operation details correctly', () => {
    const operations = parseSpec(MINIMAL_SPEC);
    const createOp = operations.find(
      (op) => op.operationId === 'GenerateController_createGeneration',
    );

    expect(createOp).toBeDefined();
    expect(createOp?.method).toBe('post');
    expect(createOp?.path).toBe('/v2/generate');
    expect(createOp?.summary).toBe('Create a generation');
    expect(createOp?.requestBody).toBeDefined();
  });

  it('parses path parameters', () => {
    const operations = parseSpec(MINIMAL_SPEC);
    const getOp = operations.find((op) => op.operationId === 'GenerateController_getGeneration');

    expect(getOp).toBeDefined();
    expect(getOp?.parameters).toHaveLength(1);
    expect(getOp?.parameters[0]?.name).toBe('id');
    expect(getOp?.parameters[0]?.in).toBe('path');
    expect(getOp?.parameters[0]?.required).toBe(true);
  });

  it('filters out internal-tagged endpoints', () => {
    const operations = parseSpec(MINIMAL_SPEC);
    const internalOp = operations.find((op) => op.operationId === 'InternalController_doSomething');
    expect(internalOp).toBeUndefined();
  });

  it('skips operations without operationId', () => {
    const spec: OpenApiSpec = {
      openapi: '3.1.0',
      paths: {
        '/v2/test': {
          get: {
            summary: 'No operation ID',
            tags: ['Test'],
          },
        },
      },
    };
    const operations = parseSpec(spec);
    expect(operations).toHaveLength(0);
  });

  it('detects multipart endpoints', () => {
    const spec: OpenApiSpec = {
      openapi: '3.1.0',
      paths: {
        '/v2/upload': {
          post: {
            operationId: 'UploadController_upload',
            summary: 'Upload a file',
            tags: ['Upload'],
            parameters: [],
            requestBody: {
              content: {
                'multipart/form-data': {
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
    };
    const operations = parseSpec(spec);
    expect(operations[0]?.isMultipart).toBe(true);
  });
});

describe('resolveRef', () => {
  it('resolves $ref to component schemas', () => {
    const spec: OpenApiSpec = {
      openapi: '3.1.0',
      paths: {},
      components: {
        schemas: {
          MyModel: { type: 'object', properties: { name: { type: 'string' } } },
        },
      },
    };

    const resolved = resolveRef(spec, '#/components/schemas/MyModel');
    expect(resolved).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
    });
  });
});

describe('resolveSchemaRefs', () => {
  const spec: OpenApiSpec = {
    openapi: '3.1.0',
    paths: {},
    components: {
      schemas: {
        Status: { type: 'string', enum: ['pending', 'completed'] },
      },
    },
  };

  it('resolves $ref in schema', () => {
    const schema = { $ref: '#/components/schemas/Status' };
    const resolved = resolveSchemaRefs(schema, spec);
    expect(resolved).toEqual({
      type: 'string',
      enum: ['pending', 'completed'],
    });
  });

  it('passes through schemas without $ref', () => {
    const schema = { type: 'string' };
    const resolved = resolveSchemaRefs(schema, spec);
    expect(resolved).toEqual({ type: 'string' });
  });

  it('resolves nested $ref in properties', () => {
    const schema = {
      type: 'object',
      properties: {
        status: { $ref: '#/components/schemas/Status' },
      },
    };
    const resolved = resolveSchemaRefs(schema, spec);
    expect(resolved).toEqual({
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'completed'] },
      },
    });
  });

  it('resolves $ref in additionalProperties', () => {
    const schema = {
      type: 'object',
      additionalProperties: { $ref: '#/components/schemas/Status' },
    };
    const resolved = resolveSchemaRefs(schema, spec);
    expect(resolved).toEqual({
      type: 'object',
      additionalProperties: { type: 'string', enum: ['pending', 'completed'] },
    });
  });
});
