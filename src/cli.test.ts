import { afterEach, expect, it, vi } from 'vitest';
import { clearToken } from './auth/token-store.js';

vi.mock('./auth/token-store.js', () => ({ clearToken: vi.fn() }));

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([
  { args: ['--base-url', 'https://override.example'], expected: 'https://override.example' },
  { args: [], expected: 'https://environment.example' },
])('logs out of the selected API despite broken app settings: $expected', async ({
  args,
  expected,
}) => {
  vi.resetModules();
  vi.stubEnv('SYNC_BASE_URL', 'https://environment.example');
  vi.stubEnv('SYNC_CHATGPT_APP_DIR', '/missing/app');
  vi.stubEnv('SYNC_CHATGPT_APP_PREVIOUS_DIRS', 'invalid JSON');
  process.argv = ['node', 'sync-mcp', '--logout', ...args];
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await import('./cli.js');
  await vi.waitFor(() =>
    expect(vi.mocked(clearToken).mock.calls.length + exit.mock.calls.length).toBe(1),
  );
  expect(clearToken).toHaveBeenCalledWith(expected);
  expect(exit).not.toHaveBeenCalled();
});
