import { createServer } from 'node:http';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { appUploadHandler, createAppUploadCors, relayUploadTool } from './app-upload-relay.js';

const upstreamAddress = vi.hoisted(() => ({ port: 0 }));
vi.mock('node:https', async () => {
  const http = await import('node:http');
  return {
    request: (_url, options, callback) =>
      http.request(`http://127.0.0.1:${upstreamAddress.port}/object`, options, callback),
  };
});
afterEach(() => vi.restoreAllMocks());

it('transfers a local 11 MB File from a sandboxed browser across CORS through the real relay', async () => {
  const { chromium } = await import('@playwright/test');
  const expectedSize = 11 * 1024 * 1024;
  let received = 0;
  let wrongByte = false;
  let storageCalls = 0;
  const storage = createServer(async (req, res) => {
    storageCalls++;
    for await (const chunk of req) {
      received += chunk.length;
      if (chunk.some((byte) => byte !== 97)) wrongByte = true;
    }
    res.writeHead(200).end();
  });
  await new Promise((r) => storage.listen(0, '127.0.0.1', r));
  upstreamAddress.port = storage.address().port;
  const app = express();
  app.use('/app-upload', createAppUploadCors(['null']));
  app.put('/app-upload', appUploadHandler);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  const origin = `http://127.0.0.1:${listener.address().port}`;
  const tool = relayUploadTool(
    {
      name: 'assets_create-upload-url',
      description: '',
      inputSchema: {},
      handler: async () => ({
        uploadUrl: 'https://storage.fixture.invalid/object',
        url: 'https://cdn.fixture.invalid/object',
        expiresIn: 300,
      }),
    },
    origin,
    'https://storage.fixture.invalid',
  );
  const signed = z
    .object({ uploadUrl: z.string() })
    .parse(await tool.handler({ size: expectedSize, contentType: 'video/mp4' }));
  const browser = await chromium.launch();
  try {
    const deniedPreflight = await fetch(`${origin}/app-upload`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://untrusted.fixture.invalid',
        'Access-Control-Request-Method': 'PUT',
      },
    });
    expect(deniedPreflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(deniedPreflight.headers.get('access-control-allow-credentials')).toBeNull();
    const page = await browser.newPage();
    // Opaque-origin iframe mirrors an embedded app rather than a same-origin browser fetch.
    await page.setContent(
      '<iframe sandbox="allow-scripts" srcdoc="<html><body>Upload fixture</body></html>"></iframe>',
    );
    const frame = page.frames()[1];
    const status = await frame.evaluate(
      async ({ uploadUrl, size }) => {
        const bytes = new Uint8Array(size).fill(97);
        const file = new File([bytes], 'fixture.mp4', { type: 'video/mp4' });
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', uploadUrl);
          xhr.setRequestHeader('Content-Type', file.type);
          xhr.timeout = 15000;
          xhr.upload.onprogress = () => {};
          xhr.onload = () => resolve(xhr.status);
          xhr.onerror = () => reject(new Error('Browser upload failed'));
          xhr.ontimeout = () => reject(new Error('Browser upload timed out'));
          xhr.send(file);
        });
      },
      { uploadUrl: signed.uploadUrl, size: expectedSize },
    );
    expect(status).toBe(204);
    expect(received).toBe(expectedSize);
    expect(wrongByte).toBe(false);
    expect(storageCalls).toBe(1);
  } finally {
    await browser.close();
    listener.closeAllConnections();
    storage.closeAllConnections();
    await Promise.all([
      new Promise((r) => listener.close(() => r())),
      new Promise((r) => storage.close(() => r())),
    ]);
  }
}, 30000);
