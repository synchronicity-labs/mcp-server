import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storePath, withStoreLock } from './token-store.js';

let home: string;
const lock = () => storePath('mcp-credentials.lock');

/** A lock as a crashed holder leaves it: its file inside, last touched a minute ago. */
async function abandonLock(holder = 'crashed-holder') {
  await fs.mkdir(lock(), { recursive: true });
  const file = path.join(lock(), holder);
  await fs.writeFile(file, '');
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(file, old, old);
}

/** Runs several lock holders at once and reports the most that ever ran together. */
async function mostAtOnce(holders: number): Promise<number> {
  let running = 0;
  let most = 0;
  await Promise.all(
    Array.from({ length: holders }, () =>
      withStoreLock(async () => {
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 40));
        running--;
      }),
    ),
  );
  return most;
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-mcp-lock-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe('the sign-in lock', () => {
  it('lets one holder run at a time and leaves nothing behind', async () => {
    expect(await mostAtOnce(4)).toBe(1);
    expect(await fs.readdir(path.dirname(lock()))).toEqual([]);
  });

  it('is taken over from a crashed holder by one waiter at a time', async () => {
    await abandonLock();

    expect(await mostAtOnce(4)).toBe(1);
  });

  it('is taken over when a crash left only its empty directory', async () => {
    await fs.mkdir(lock(), { recursive: true });

    await expect(withStoreLock(async () => 'ran')).resolves.toBe('ran');
  });

  it('releases only its own hold, so a holder that took over keeps the lock', async () => {
    let successor: Promise<void> | undefined;
    await withStoreLock(async () => {
      // This holder outlives the stale limit: its file looks abandoned and is taken over.
      const [holder] = await fs.readdir(lock());
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(path.join(lock(), holder as string), old, old);
      let successorRunning = false;
      successor = withStoreLock(async () => {
        successorRunning = true;
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      await vi.waitFor(() => expect(successorRunning).toBe(true));
    });

    // The first holder has released, and the successor's hold is still there.
    expect(await fs.readdir(lock())).toHaveLength(1);
    await successor;
  });
});
