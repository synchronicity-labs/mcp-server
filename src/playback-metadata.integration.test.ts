import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { createMcpServerFactory } from './server.js';

it('reads only user-authorized playback metadata and rechecks identity and asset access on every call', async () => {
  const assetId = '00000000-0000-4000-8000-000000000003';
  const accountId = '00000000-0000-4000-8000-000000000001';
  const otherId = '00000000-0000-4000-8000-000000000099';
  const metadata = {
    assetId,
    duration: 2,
    fps: 10,
    frameCount: 20,
    width: 160,
    height: 90,
    codec: 'h264',
    format: 'mp4',
    proxyPath: null,
    proxyRequested: false,
    thumbnailsManifestUrl: null,
  };
  let mode = 'ready';
  const calls: string[] = [];
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api-json') {
      res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
      return;
    }
    calls.push(req.url!);
    expect(req.method).toBe('GET');
    expect(req.headers['x-sync-source']).toBe('mcp:openai-mcp');
    if (req.url === '/v2/oauth/account') {
      if (mode === 'revoked') {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: 'Connection revoked' }));
        return;
      }
      res.end(
        JSON.stringify({
          account: req.headers.authorization === 'Bearer api-key' ? null : { id: accountId },
        }),
      );
      return;
    }
    if (mode === 'denied') {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'Asset not found' }));
      return;
    }
    const row = {
      ...metadata,
      transcript: { text: 'private-script' },
      videoAnalysis: { stimulus: { spriteSheetUrls: ['private-analysis'] } },
      faceDetectionUrl: 'private-faces',
      activeSpeakerUrl: 'private-speakers',
    };
    res.end(
      JSON.stringify(
        mode === 'empty'
          ? []
          : mode === 'mismatch'
            ? [{ ...row, assetId: otherId }]
            : mode === 'multiple'
              ? [row, row]
              : [row],
      ),
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'http',
    port: 0,
  });
  const server = factory.createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  await client.connect(ct);
  const read = (token = 'oauth-user', id = assetId) =>
    runWithAuth(token, 'openai-mcp', () =>
      client.callTool({ name: 'get-playback-metadata', arguments: { assetId: id } }),
    );
  try {
    const catalog = (await client.listTools()).tools;
    expect(
      catalog.find((tool) => tool.name === 'get-playback-metadata')?.annotations?.readOnlyHint,
    ).toBe(true);
    const ready = await read();
    expect(ready.isError).not.toBe(true);
    expect(ready.structuredContent).toEqual({ supported: true, metadata });
    expect(JSON.stringify(ready)).not.toContain('private-');
    expect(calls.splice(0)).toEqual([
      '/v2/oauth/account',
      `/v2/asset-metadata/by-asset?assetId=${assetId}`,
    ]);
    mode = 'empty';
    expect((await read()).structuredContent).toEqual({ supported: true, metadata: null });
    expect(calls.splice(0)).toEqual([
      '/v2/oauth/account',
      `/v2/asset-metadata/by-asset?assetId=${assetId}`,
    ]);
    for (mode of ['mismatch', 'multiple', 'denied']) {
      expect((await read()).isError).toBe(true);
      expect(calls.splice(0)).toEqual([
        '/v2/oauth/account',
        `/v2/asset-metadata/by-asset?assetId=${assetId}`,
      ]);
    }
    mode = 'revoked';
    expect((await read()).isError).toBe(true);
    expect(calls.splice(0)).toEqual(['/v2/oauth/account']);
    mode = 'ready';
    expect((await read('api-key')).structuredContent).toEqual({ supported: false, metadata: null });
    expect(calls.splice(0)).toEqual(['/v2/oauth/account']);
    expect((await read('oauth-user', 'https://private.example/metadata')).isError).toBe(true);
    expect(calls).toEqual([]);
  } finally {
    await client.close();
    await server.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
