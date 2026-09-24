import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { closeFixtureServers } from './fixture-cleanup.js';

it.each([
  'before upstream',
  'before hosted',
  'hosted created',
  'both started',
])('cleans partial startup: %s', async (stage) => {
  const upstream = stage === 'before upstream' ? undefined : createServer();
  const hosted = ['hosted created', 'both started'].includes(stage) ? createServer() : undefined;
  if (upstream) {
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
  }
  if (hosted && stage === 'both started') {
    hosted.listen(0, '127.0.0.1');
    await once(hosted, 'listening');
  }
  const original = new Error('original startup failure');
  await expect(
    (async () => {
      try {
        throw original;
      } finally {
        await closeFixtureServers(hosted, upstream);
      }
    })(),
  ).rejects.toBe(original);
  expect(upstream?.listening ?? false).toBe(false);
  expect(hosted?.listening ?? false).toBe(false);
  await expect(closeFixtureServers(hosted, upstream)).resolves.toBeUndefined();
});
