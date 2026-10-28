import { describe, expect, it, vi } from 'vitest';
import { parseSpec } from '../openapi/parser.js';
import type { ParsedOperation } from '../openapi/types.js';
import { createAudioTrimTools } from './audio-trim.js';

const operations: ParsedOperation[] = [
  {
    operationId: 'AudioTrims_create',
    method: 'post',
    path: '/v2/audio-trims',
    summary: '',
    isMultipart: false,
    tags: [],
    parameters: [
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      },
    ],
    requestBody: {
      contentType: 'application/json',
      schema: {
        type: 'object',
        properties: {
          assetId: { type: 'string', format: 'uuid' },
          durationSeconds: { type: 'number' },
        },
      },
    },
  },
  {
    operationId: 'AudioTrims_get',
    method: 'get',
    path: '/v2/audio-trims/{id}',
    summary: '',
    isMultipart: false,
    tags: [],
    parameters: [],
  },
];
describe('audio preparation tools', () => {
  it('discovers the deployed audio-trim tag through the OpenAPI parser', () => {
    const parsed = parseSpec({
      openapi: '3.0.0',
      paths: {
        '/v2/audio-trims': {
          post: {
            operationId: 'AudioTrimsController_create',
            tags: ['Audio trims'],
            parameters: [
              { in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      assetId: { type: 'string', format: 'uuid' },
                      durationSeconds: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
        '/v2/audio-trims/{id}': {
          get: { operationId: 'AudioTrimsController_get', tags: ['Audio trims'] },
        },
      },
    });
    expect(createAudioTrimTools(parsed, { request: vi.fn() }).map((tool) => tool.name)).toEqual([
      'trim-audio',
      'get-audio-trim',
    ]);
  });
  it('fails closed until keyed trim routes are advertised', () => {
    expect(createAudioTrimTools([], { request: vi.fn() })).toEqual([]);
    expect(createAudioTrimTools(operations.slice(0, 1), { request: vi.fn() })).toEqual([]);
  });
  it('forwards the frozen trim key and never generates a video', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const request = vi.fn().mockResolvedValue({
      id,
      status: 'queued',
      assetId: null,
      durationSeconds: null,
      errorCode: null,
      retryAfterMs: 2000,
    });
    const tools = createAudioTrimTools(operations, { request });
    await tools[0]!.handler({
      audioAssetId: id,
      durationSeconds: 15,
      idempotencyKey: id,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith('post', '/v2/audio-trims', {
      body: { assetId: id, durationSeconds: 15 },
      headers: { 'Idempotency-Key': id },
      signal: undefined,
    });
    await tools[1]!.handler({ id });
    expect(request).toHaveBeenLastCalledWith('get', `/v2/audio-trims/${id}`, {
      signal: undefined,
    });
  });
});
