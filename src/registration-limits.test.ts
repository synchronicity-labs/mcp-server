import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { namesOnlyHostedAgentCallbacks } from './auth/client-registration.js';
import {
  createRegistrationLimits,
  HOSTED_AGENT_REGISTRATIONS_PER_ADDRESS_PER_HOUR,
  REGISTRATIONS_PER_ADDRESS_PER_HOUR,
  REGISTRATIONS_PER_HOUR,
} from './rate-limits.js';

// The limits alone, with fresh buckets. As in production, the app trusts one proxy hop,
// so X-Forwarded-For stands in for each caller's address.
let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.post(
    '/register',
    express.json(),
    createRegistrationLimits((req) =>
      namesOnlyHostedAgentCallbacks((req.body as { redirect_uris?: unknown }).redirect_uris),
    ),
    (_req, res) => {
      res.status(201).end();
    },
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});
afterAll(() => close());

async function register(address: string, redirectUris: string[]) {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
    body: JSON.stringify({ redirect_uris: redirectUris }),
  });
  await res.arrayBuffer();
  return res.status;
}

const hosted = ['https://claude.ai/api/mcp/auth_callback'];
const ordinary = ['http://localhost:7777/oauth/callback'];

// The tests share one app, so their order is part of the scenario.
it('stops hosted-app registrations from one address at their own allowance', async () => {
  for (let i = 0; i < HOSTED_AGENT_REGISTRATIONS_PER_ADDRESS_PER_HOUR; i++)
    expect(await register('198.51.100.1', hosted)).toBe(201);
  expect(await register('198.51.100.1', hosted)).toBe(429);
  // Another address, and ordinary registrations from the same one, are not affected.
  expect(await register('198.51.100.2', hosted)).toBe(201);
  expect(await register('198.51.100.1', ordinary)).toBe(201);
});

it('stops ordinary registrations at the pod-wide cap, across addresses', async () => {
  // One ordinary registration above already counted toward the pod-wide cap.
  let sent = 1;
  for (let address = 0; sent < REGISTRATIONS_PER_HOUR; address++) {
    for (let i = 0; i < REGISTRATIONS_PER_ADDRESS_PER_HOUR && sent < REGISTRATIONS_PER_HOUR; i++) {
      expect(await register(`203.0.113.${address}`, ordinary)).toBe(201);
      sent++;
    }
  }
  // A fresh address is under its own limit, but the pod has none left.
  expect(await register('192.0.2.200', ordinary)).toBe(429);
  // Hosted-app registrations do not draw on the pod-wide cap.
  expect(await register('192.0.2.200', hosted)).toBe(201);
});
