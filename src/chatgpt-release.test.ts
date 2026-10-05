import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatgptReleaseSchema } from './chatgpt-release.js';
import { resolveConfig } from './config.js';

const current = 'a'.repeat(64);
const previous = 'b'.repeat(64);
let root: string;
let catalog: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chatgpt-release-'));
  catalog = join(root, 'releases.json');
  writeFileSync(catalog, JSON.stringify({ current, previous: [previous] }));
  vi.stubEnv('SYNC_CHATGPT_APP_RELEASES', catalog);
  vi.stubEnv('SYNC_CHATGPT_APP_DIR', join(root, previous));
  vi.stubEnv('SYNC_CHATGPT_APP_PREVIOUS_DIRS', '[]');
  vi.stubEnv('SYNC_CHATGPT_APP_DOMAIN', 'https://mcp.sync.so');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('packaged UI selection', () => {
  it('activates the approved release despite the existing production directory pin', () => {
    expect(resolveConfig().chatgptApp).toMatchObject({
      directory: join(root, current),
      previousDirectories: [join(root, previous)],
      domain: 'https://mcp.sync.so',
    });
  });

  it('retains externally mounted legacy bundles and deduplicates packaged paths', () => {
    vi.stubEnv('SYNC_CHATGPT_APP_DIR', '/mounted/legacy-ui');
    vi.stubEnv(
      'SYNC_CHATGPT_APP_PREVIOUS_DIRS',
      JSON.stringify([join(root, previous), join(root, current)]),
    );
    expect(resolveConfig().chatgptApp?.previousDirectories).toEqual([
      join(root, previous),
      '/mounted/legacy-ui',
    ]);
  });

  it('does not resurrect a pruned image bundle from a stale legacy pin', () => {
    vi.stubEnv('SYNC_CHATGPT_APP_DIR', join(root, 'c'.repeat(64)));
    expect(resolveConfig().chatgptApp?.previousDirectories).toEqual([join(root, previous)]);
  });

  it('keeps API-only Docker deployments working without widget configuration', () => {
    vi.stubEnv('SYNC_CHATGPT_APP_DOMAIN', '');
    vi.stubEnv('SYNC_CHATGPT_APP_DIR', '');
    expect(resolveConfig().chatgptApp).toBeUndefined();
  });

  it('rolls back through the release manifest while retaining the newer UI', () => {
    writeFileSync(catalog, JSON.stringify({ current: previous, previous: [current] }));
    expect(resolveConfig().chatgptApp).toMatchObject({
      directory: join(root, previous),
      previousDirectories: [join(root, current)],
    });
  });

  it('preserves explicit library configuration without reading environment paths', () => {
    vi.stubEnv('SYNC_CHATGPT_APP_RELEASES', '/missing/releases.json');
    const explicit = {
      directory: '/custom/ui',
      domain: 'https://custom.example',
      resourceDomains: [],
    };
    expect(resolveConfig({ chatgptApp: explicit }).chatgptApp).toBe(explicit);
  });

  it('preserves legacy local configuration outside the packaged image', () => {
    vi.stubEnv('SYNC_CHATGPT_APP_RELEASES', '');
    expect(resolveConfig().chatgptApp?.directory).toBe(join(root, previous));
    vi.stubEnv('SYNC_CHATGPT_APP_DIR', '');
    expect(resolveConfig().chatgptApp).toBeUndefined();
  });

  it('fails closed on a missing or malformed configured release manifest', () => {
    writeFileSync(catalog, '{');
    expect(() => resolveConfig()).toThrow();
    rmSync(catalog);
    expect(() => resolveConfig()).toThrow();
  });

  it.each([
    { current: '../outside', previous: [] },
    { current, previous: [current] },
    { current, previous: [previous, previous] },
    { current, previous: Array(9).fill(previous) },
  ])('rejects unsafe or ambiguous release manifests: %j', (value) => {
    expect(chatgptReleaseSchema.safeParse(value).success).toBe(false);
  });
});
