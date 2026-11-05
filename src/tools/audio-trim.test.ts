import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
      'audio-trims_create',
      'audio-trims_get',
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
  it('takes the API name assetId and still accepts audioAssetId', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const other = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    const request = vi.fn().mockResolvedValue({
      id,
      status: 'queued',
      assetId: null,
      durationSeconds: null,
      errorCode: null,
      retryAfterMs: 2000,
    });
    const [trim] = createAudioTrimTools(operations, { request });
    const schema = z.toJSONSchema(z.object(trim!.inputSchema)) as {
      required?: string[];
      properties: Record<string, { deprecated?: boolean }>;
    };
    expect(schema.required).not.toContain('assetId');
    expect(schema.required).not.toContain('audioAssetId');
    expect(schema.properties.assetId?.deprecated).toBeUndefined();
    expect(schema.properties.audioAssetId?.deprecated).toBe(true);
    expect(trim!.description).toContain(
      'audio asset, passed as assetId, as a new reusable asset. Explain and confirm',
    );
    for (const source of [{ assetId: id }, { audioAssetId: id }, { assetId: id, audioAssetId: id }])
      await trim!.handler({ ...source, durationSeconds: 15, idempotencyKey: id });
    expect(request.mock.calls.map(([, , options]) => options.body)).toEqual(
      [1, 2, 3].map(() => ({ assetId: id, durationSeconds: 15 })),
    );
    await expect(
      trim!.handler({ assetId: id, audioAssetId: other, durationSeconds: 15, idempotencyKey: id }),
    ).rejects.toThrow('assetId and audioAssetId name different assets');
    await expect(trim!.handler({ durationSeconds: 15, idempotencyKey: id })).rejects.toThrow(
      'Pass assetId.',
    );
    expect(request).toHaveBeenCalledTimes(3);
  });
});
