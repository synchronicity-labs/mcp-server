import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from './config.js';
import {
  compareVersions,
  parseUpdateCheck,
  startConfiguredUpdateCheck,
  startUpdateCheck,
  UPDATE_CHECK_TTL_MS,
} from './update-check.js';

const LATEST_URL = 'https://registry.npmjs.org/@sync.so/mcp-server/latest';
const NOW = Date.parse('2026-11-04T12:00:00.000Z');
let tempDir: string;
let cacheFile: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'sync-update-check-'));
  cacheFile = path.join(tempDir, 'nested', 'c.json');
});

// One test points cacheFile elsewhere, so clean up by the directory, not the file.
afterEach(() => rm(tempDir, { recursive: true, force: true }));

function registry(version: unknown) {
  return vi.fn<typeof fetch>(async () => Response.json({ name: '@sync.so/mcp-server', version }));
}

async function check(currentVersion: string, fetchImpl: typeof fetch, timeoutMs?: number) {
  const updateCheck = startUpdateCheck({
    currentVersion,
    cacheFile,
    fetch: fetchImpl,
    now: () => NOW,
    timeoutMs,
  });
  await updateCheck.done;
  return updateCheck.available();
}

describe('compareVersions', () => {
  it.each([
    ['0.1.4', '0.1.5', -1],
    ['0.1.10', '0.1.9', 1],
    ['1.0.0', '1.0.0', 0],
    ['v1.2.3', '1.2.3', 0],
    ['1.0.0-beta.2', '1.0.0', -1],
    ['1.0.0-beta.2', '1.0.0-beta.10', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0+build.1', '1.0.0', 0],
  ])('compares %s with %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
    expect(compareVersions(b, a)).toBe(expected === 0 ? 0 : -expected);
  });

  it('refuses versions that are not semver', () => {
    expect(compareVersions('latest', '0.1.4')).toBeUndefined();
    expect(compareVersions('0.1', '0.1.4')).toBeUndefined();
  });
});

describe('startUpdateCheck', () => {
  it('reports a newer registry version and caches it', async () => {
    const fetchImpl = registry('0.2.0');
    expect(await check('0.1.4', fetchImpl)).toEqual({ current: '0.1.4', latest: '0.2.0' });
    expect(fetchImpl).toHaveBeenCalledWith(LATEST_URL, expect.anything());
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toEqual({
      checkedAt: new Date(NOW).toISOString(),
      latest: '0.2.0',
    });
  });

  it.each([
    ['the same', '0.1.4'],
    ['an older', '0.1.3'],
    ['a prerelease of the same', '0.1.4-beta.1'],
  ])('stays silent when the registry has %s version', async (_, latest) => {
    expect(await check('0.1.4', registry(latest))).toBeUndefined();
  });

  it('stays silent when this copy is newer than the registry', async () => {
    expect(await check('0.3.0-beta.1', registry('0.2.0'))).toBeUndefined();
  });

  it.each([
    ['an error status', async () => new Response('down', { status: 503 })],
    [
      'a network failure',
      async () => {
        throw new TypeError('fetch failed');
      },
    ],
    ['an unparsable body', async () => new Response('<html>')],
    ['a missing version', async () => Response.json({ name: '@sync.so/mcp-server' })],
    ['a version that is not semver', async () => Response.json({ version: 'latest' })],
  ])('stays silent on %s and caches the attempt', async (_, response) => {
    const fetchImpl = vi.fn<typeof fetch>(response);
    expect(await check('0.1.4', fetchImpl)).toBeUndefined();
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toEqual({
      checkedAt: new Date(NOW).toISOString(),
    });
    // Within a day the failed attempt is not repeated.
    expect(await check('0.1.4', fetchImpl)).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns before the registry answers and never waits on it', async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const updateCheck = startUpdateCheck({ currentVersion: '0.1.4', cacheFile, fetch: pending });
    let settled = false;
    void updateCheck.done.then(() => (settled = true));
    await vi.waitFor(() => expect(pending).toHaveBeenCalled());
    // The request is in flight: the caller already has the check and nothing to report.
    expect(settled).toBe(false);
    expect(updateCheck.available()).toBeUndefined();

    answer(Response.json({ version: '0.2.0' }));
    await updateCheck.done;
    expect(updateCheck.available()).toEqual({ current: '0.1.4', latest: '0.2.0' });
  });

  it('gives up on a registry that never answers', async () => {
    let signal: AbortSignal | undefined;
    const hanging = vi.fn<typeof fetch>(
      (_, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(signal?.reason));
        }),
    );
    const updateCheck = startUpdateCheck({
      currentVersion: '0.1.4',
      cacheFile,
      fetch: hanging,
      timeoutMs: 1,
    });
    // Settles only through the timeout's abort; no wall-clock bound to race a busy worker.
    await updateCheck.done;
    expect(signal?.aborted).toBe(true);
    expect(updateCheck.available()).toBeUndefined();
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toEqual({
      checkedAt: expect.any(String),
    });
  });

  it('uses a fresh cache without asking the registry', async () => {
    await check('0.1.4', registry('0.2.0'));
    const fetchImpl = registry('0.3.0');
    const updateCheck = startUpdateCheck({
      currentVersion: '0.1.4',
      cacheFile,
      fetch: fetchImpl,
      now: () => NOW + UPDATE_CHECK_TTL_MS - 1,
    });
    await updateCheck.done;
    expect(updateCheck.available()).toEqual({ current: '0.1.4', latest: '0.2.0' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stays silent from a cached version once this copy has caught up', async () => {
    await check('0.1.4', registry('0.2.0'));
    const fetchImpl = registry('0.2.0');
    expect(await check('0.2.0', fetchImpl)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['a day old', NOW - UPDATE_CHECK_TTL_MS],
    ['dated in the future', NOW + 60_000],
  ])('asks the registry again when the cache is %s', async (_, checkedAt) => {
    // A first check creates the cache directory.
    await check('0.1.4', registry('0.1.5'));
    await writeFile(
      cacheFile,
      JSON.stringify({ checkedAt: new Date(checkedAt).toISOString(), latest: '0.1.5' }),
    );
    const fetchImpl = registry('0.3.0');
    expect(await check('0.1.4', fetchImpl)).toEqual({ current: '0.1.4', latest: '0.3.0' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ignores a corrupt cache', async () => {
    await check('0.1.4', registry('0.1.5'));
    await writeFile(cacheFile, '{not json');
    expect(await check('0.1.4', registry('0.2.0'))).toEqual({ current: '0.1.4', latest: '0.2.0' });
  });

  it('still reports when the cache cannot be written', async () => {
    cacheFile = '/dev/null/sync/mcp-update-check.json';
    expect(await check('0.1.4', registry('0.2.0'))).toEqual({ current: '0.1.4', latest: '0.2.0' });
  });
});

describe('startConfiguredUpdateCheck', () => {
  const stdio = { transport: 'stdio' as const, updateCheck: true };

  it.each([
    ['the hosted HTTP server', { transport: 'http' as const, updateCheck: true }, {}],
    ['an opted-out install', { transport: 'stdio' as const, updateCheck: false }, {}],
    ['CI', stdio, { CI: 'true' }],
    ['CI=1', stdio, { CI: '1' }],
  ])('never checks for %s', (_, config, env) => {
    const fetchImpl = registry('9.9.9');
    expect(
      startConfiguredUpdateCheck(config, '0.1.4', env, { cacheFile, fetch: fetchImpl }),
    ).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([{}, { CI: '' }, { CI: 'false' }, { CI: '0' }])(
    'checks a local install outside CI (%j)',
    async (env) => {
      const fetchImpl = registry('9.9.9');
      const updateCheck = startConfiguredUpdateCheck(stdio, '0.1.4', env, {
        cacheFile,
        fetch: fetchImpl,
      });
      await updateCheck?.done;
      expect(updateCheck?.available()).toEqual({ current: '0.1.4', latest: '9.9.9' });
    },
  );
});

describe('parseUpdateCheck', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['off', false],
    [' OFF ', false],
    ['false', false],
    ['0', false],
    ['no', false],
    ['on', true],
    ['1', true],
  ])('parses %j', (value, expected) => {
    expect(parseUpdateCheck(value)).toBe(expected);
  });

  it('rejects other values', () => {
    expect(() => parseUpdateCheck('sometimes')).toThrow('SYNC_MCP_UPDATE_CHECK must be on or off');
  });
});

describe('resolveConfig', () => {
  it('reads SYNC_MCP_UPDATE_CHECK, CLI overrides first', () => {
    const previous = process.env.SYNC_MCP_UPDATE_CHECK;
    try {
      delete process.env.SYNC_MCP_UPDATE_CHECK;
      expect(resolveConfig().updateCheck).toBe(true);
      process.env.SYNC_MCP_UPDATE_CHECK = 'off';
      expect(resolveConfig().updateCheck).toBe(false);
      expect(resolveConfig({ updateCheck: true }).updateCheck).toBe(true);
      process.env.SYNC_MCP_UPDATE_CHECK = 'on';
      expect(resolveConfig({ updateCheck: false }).updateCheck).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.SYNC_MCP_UPDATE_CHECK;
      else process.env.SYNC_MCP_UPDATE_CHECK = previous;
    }
  });
});
