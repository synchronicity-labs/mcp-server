import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:os', async (original) => ({ ...(await original<typeof os>()), homedir: vi.fn() }));

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-credentials-test-'));
  vi.mocked(os.homedir).mockReturnValue(home);
  vi.resetModules();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

it('isolates API credentials and logout, including trailing-slash aliases', async () => {
  const { saveToken, loadToken, clearToken } = await import('./token-store.js');
  const expiry = new Date(Date.now() + 60000).toISOString();
  await saveToken('production', expiry);
  await saveToken('development', expiry, 'https://dev.example.com/');
  expect(await loadToken('https://dev.example.com')).toBe('development');
  expect(await loadToken()).toBe('production');
  await clearToken('https://dev.example.com');
  expect(await loadToken('https://dev.example.com')).toBeNull();
  expect(await loadToken()).toBe('production');
});

it('does not reuse legacy unscoped credentials in a different environment', async () => {
  const dir = path.join(home, '.config', 'sync');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'mcp-credentials.json'), JSON.stringify({ token: 'legacy' }));
  const { loadToken } = await import('./token-store.js');
  expect(await loadToken('https://dev.example.com')).toBeNull();
  expect(await loadToken()).toBeNull();
});

it('rejects invalid and expired lifetimes and writes credentials with private permissions', async () => {
  const { saveToken, loadToken } = await import('./token-store.js');
  await saveToken('expired', new Date(Date.now() - 1000).toISOString());
  expect(await loadToken()).toBeNull();
  await saveToken('invalid', 'invalid-date');
  expect(await loadToken()).toBeNull();
  const files = await fs.readdir(path.join(home, '.config', 'sync'));
  const stat = await fs.stat(path.join(home, '.config', 'sync', files[0]!));
  expect(stat.mode & 0o777).toBe(0o600);
});
