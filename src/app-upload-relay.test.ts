import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { appUploadHandler, relayUploadTool } from './app-upload-relay.js';

const upstreamAddress = vi.hoisted(() => ({ port: 0 }));
vi.mock('node:https', async () => {
  const http = await import('node:http');
  return {
    request: (_url: string, options: object, callback: unknown) =>
      http.request(`http://127.0.0.1:${upstreamAddress.port}/object`, options, callback as never),
  };
});
afterEach(() => vi.restoreAllMocks());

it('streams exact bytes to the issued destination and rejects replay, unknown tickets and mismatched inputs', async () => {
  let bytes = Buffer.alloc(0);
  let calls = 0;
  let mime: string | undefined;
  const storage = createServer((req, res) => {
    calls++;
    mime = req.headers['content-type'];
    req.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
    });
    req.on('end', () => res.writeHead(200).end());
  });
  await new Promise<void>((resolve) => storage.listen(0, '127.0.0.1', resolve));
  upstreamAddress.port = (storage.address() as AddressInfo).port;
  const app = express();
  app.put('/app-upload', appUploadHandler);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const tool = relayUploadTool(
    {
      name: 'assets_create-upload-url',
      inputSchema: {},
      description: '',
      handler: async () => ({
        uploadUrl: 'https://storage.fixture.invalid/signed',
        url: 'https://cdn.fixture.invalid/file',
        expiresIn: 3600,
      }),
    },
    origin,
    'https://storage.fixture.invalid',
  );
  try {
    const signed = z
      .object({ uploadUrl: z.string() })
      .parse(await tool.handler({ size: 5, contentType: 'video/mp4' }));
    expect(
      (
        await fetch(signed.uploadUrl, {
          method: 'PUT',
          body: 'hello',
          headers: { 'Content-Type': 'audio/wav' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(signed.uploadUrl, {
          method: 'PUT',
          body: 'hello',
          headers: { 'Content-Type': 'video/mp4' },
        })
      ).status,
    ).toBe(204);
    expect(bytes.toString()).toBe('hello');
    expect(mime).toBe('video/mp4');
    expect(
      (
        await fetch(signed.uploadUrl, {
          method: 'PUT',
          body: 'hello',
          headers: { 'Content-Type': 'video/mp4' },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${origin}/app-upload?ticket=unknown`, { method: 'PUT' })).status).toBe(
      403,
    );
    expect(calls).toBe(1);
  } finally {
    listener.closeAllConnections();
    storage.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => listener.close(() => r())),
      new Promise<void>((r) => storage.close(() => r())),
    ]);
  }
});

it('refuses unexpected destinations and files above the bounded relay limit', async () => {
  const handler = vi.fn(async () => ({
    uploadUrl: 'https://unexpected.invalid/file',
    url: 'https://cdn.fixture.invalid/file',
    expiresIn: 3600,
  }));
  const tool = relayUploadTool(
    { name: 'assets_create-upload-url', description: '', inputSchema: {}, handler },
    'https://app.fixture.invalid',
    'https://storage.fixture.invalid',
  );
  await expect(tool.handler({ size: 1, contentType: 'video/mp4' })).rejects.toThrow(
    'Unexpected storage',
  );
  await expect(tool.handler({ size: 6 * 1024 ** 3, contentType: 'video/mp4' })).rejects.toThrow(
    'supports uploads up to',
  );
  expect(handler).toHaveBeenCalledTimes(1);
});

it.each([
  { size: 5, expiresIn: undefined },
  { size: 600 * 1024 ** 2, expiresIn: 60 },
])('preserves presign compatibility for %j', async ({ size, expiresIn }) => {
  const tool = relayUploadTool(
    {
      name: 'assets_create-upload-url',
      description: '',
      inputSchema: {},
      handler: async () => ({
        uploadUrl: 'https://storage.fixture.invalid/signed',
        url: 'https://cdn.fixture.invalid/file',
        ...(expiresIn === undefined ? {} : { expiresIn }),
      }),
    },
    'https://app.fixture.invalid',
    'https://storage.fixture.invalid',
  );
  const grant = z
    .object({ uploadUrl: z.url(), url: z.url(), expiresIn: z.number() })
    .parse(await tool.handler({ size, contentType: 'video/mp4' }));
  expect(grant.url).toBe('https://cdn.fixture.invalid/file');
  expect(grant.uploadUrl).toMatch(
    /^https:\/\/app\.fixture\.invalid\/app-upload\?ticket=[a-f0-9]{64}$/,
  );
  expect(grant.expiresIn).toBe(expiresIn ?? 300);
});
