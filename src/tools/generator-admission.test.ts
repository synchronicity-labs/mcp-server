import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import { generateTools } from './generator.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function operation(required: boolean): ParsedOperation {
  return {
    operationId: 'GenerateController_createGeneration',
    method: 'post',
    path: '/v2/generate',
    tags: ['Generate'],
    summary: 'Create a job',
    parameters: [{ name: 'Idempotency-Key', in: 'header', required, schema: { type: 'string' } }],
    requestBody: {
      contentType: 'application/json',
      schema: { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] },
    },
    isMultipart: false,
  };
}

describe('generated write admission at the HTTP boundary', () => {
  it.each([false, true])(
    'forwards a %s-required key in the header and reuses it unchanged',
    async (required) => {
      const received: Array<{ key: string | string[] | undefined; body: unknown }> = [];
      const server = createServer((request, response) => {
        let bytes = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
          bytes += chunk;
        });
        request.on('end', () => {
          received.push({ key: request.headers['idempotency-key'], body: JSON.parse(bytes) });
          response.writeHead(201, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id: 'saved-job', status: 'PENDING' }));
        });
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      closers.push(
        () =>
          new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      );
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test listener.');
      const [tool] = generateTools(
        [operation(required)],
        createHttpClient(`http://127.0.0.1:${address.port}`),
      );
      const input = { model: 'sync-3', idempotencyKey: 'approved-request-1' };
      await tool!.handler(input);
      await tool!.handler(input);
      expect(received).toEqual([
        { key: 'approved-request-1', body: { model: 'sync-3' } },
        { key: 'approved-request-1', body: { model: 'sync-3' } },
      ]);
    },
  );

  it('rejects missing required and malformed keys before any request', async () => {
    const http = {
      request: async () => {
        throw new Error('Unexpected HTTP call.');
      },
    };
    const [required] = generateTools([operation(true)], http);
    await expect(required!.handler({ model: 'sync-3' })).rejects.toThrow(/expected string/i);
    await expect(
      required!.handler({ model: 'sync-3', idempotencyKey: 'bad\r\nheader' }),
    ).rejects.toThrow(/pattern/i);
  });
});
