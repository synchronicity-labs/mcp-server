import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { finalErrorHandler, requireStatusToken } from './http-errors.js';

const events: Array<[string, Record<string, unknown> | undefined]> = [];
let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const app = express();
  app.use('/json', express.json({ limit: '1kb' }));
  app.post('/json', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/throws', () => {
    throw new Error('secret internal detail');
  });
  app.get('/status', requireStatusToken('operator'), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/disabled', requireStatusToken(undefined), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(finalErrorHandler((event, details) => events.push([event, details])));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});
afterAll(async () => {
  await close();
  vi.unstubAllEnvs();
});

it.each(['development', 'test', undefined])(
  'answers a malformed body with JSON and no stack (NODE_ENV=%s)',
  async (env) => {
    vi.stubEnv('NODE_ENV', env);
    const response = await fetch(`${base}/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"unterminated',
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: 'invalid_request',
      error_description: 'The request could not be read',
    });
    expect(text).not.toMatch(/at |node_modules|SyntaxError|unterminated/);
  },
);

it('keeps the status of a body over its limit', async () => {
  const response = await fetch(`${base}/json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(4_000) }),
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: 'invalid_request' });
});

it('answers an unexpected throw with a generic 500 and logs the detail', async () => {
  const response = await fetch(`${base}/throws`);
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({
    error: 'server_error',
    error_description: 'Internal server error',
  });
  expect(text).not.toContain('secret internal detail');
  expect(events.at(-1)).toEqual([
    'http_unhandled_error',
    expect.objectContaining({
      statusCode: 500,
      error: expect.objectContaining({ message: 'secret internal detail' }),
    }),
  ]);
});

it('opens /status only with the operator token, and not at all without one configured', async () => {
  expect((await fetch(`${base}/status`)).status).toBe(401);
  expect(
    (await fetch(`${base}/status`, { headers: { Authorization: 'Bearer wrong' } })).status,
  ).toBe(401);
  expect(
    (await fetch(`${base}/status`, { headers: { Authorization: 'Bearer operator' } })).status,
  ).toBe(200);
  expect(
    (await fetch(`${base}/disabled`, { headers: { Authorization: 'Bearer anything' } })).status,
  ).toBe(404);
});
