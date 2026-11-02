import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-staged-file-size.mjs', import.meta.url));
const LIMIT = 20_000;

function repository(t) {
  const directory = mkdtempSync(join(tmpdir(), 'staged-file-size-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  return directory;
}

function stage(directory, path, bytes) {
  const file = join(directory, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'x'.repeat(bytes));
  execFileSync('git', ['add', '--', path], { cwd: directory });
}

function commit(directory) {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '--quiet', '-m', 'c'],
    { cwd: directory },
  );
}

function check(directory) {
  return spawnSync(process.execPath, [checker], { cwd: directory, encoding: 'utf8' });
}

void test('allows files at or under the limit', (t) => {
  const directory = repository(t);
  stage(directory, 'src/small.ts', LIMIT);
  assert.equal(check(directory).status, 0);
});

void test('blocks a new file over the limit and explains how to split it', (t) => {
  const directory = repository(t);
  stage(directory, 'src/large.ts', LIMIT + 1);
  const result = check(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/large\.ts: 5,000\.25 tokens \(20,001 bytes\)/);
  assert.match(result.stderr, /Split each oversized file/);
});

void test('blocks a committed small file that grows past the limit', (t) => {
  const directory = repository(t);
  stage(directory, 'src/grows.ts', 100);
  commit(directory);
  stage(directory, 'src/grows.ts', LIMIT + 1);
  assert.equal(check(directory).status, 1);
});

void test('exempts files already over the limit, including through a rename', (t) => {
  const directory = repository(t);
  stage(directory, 'src/legacy.ts', LIMIT + 5_000);
  commit(directory);
  stage(directory, 'src/legacy.ts', LIMIT + 6_000);
  assert.equal(check(directory).status, 0);
  execFileSync('git', ['mv', 'src/legacy.ts', 'src/renamed.ts'], { cwd: directory });
  assert.equal(check(directory).status, 0);
});

void test('ignores lockfiles and packaged UI releases', (t) => {
  const directory = repository(t);
  stage(directory, 'pnpm-lock.yaml', LIMIT * 3);
  stage(directory, 'deploy/chatgpt/abc/index.html', LIMIT * 3);
  assert.equal(check(directory).status, 0);
});
