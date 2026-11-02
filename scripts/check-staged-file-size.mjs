#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_TOKENS = 5_000;
const BYTES_PER_TOKEN = 4;
const MAX_BYTES = MAX_TOKENS * BYTES_PER_TOKEN;

const LOCKFILE_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'Cartfile.resolved',
  'Cargo.lock',
  'composer.lock',
  'flake.lock',
  'Gemfile.lock',
  'gradle.lockfile',
  'mix.lock',
  'npm-shrinkwrap.json',
  'Package.resolved',
  'packages.lock.json',
  'package-lock.json',
  'Podfile.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'pubspec.lock',
  'yarn.lock',
]);

// Packaged ChatGPT UI releases are build outputs, not agent-authored source.
const GENERATED_PREFIXES = ['deploy/'];

const GENERATED_PATH = /(?:^|\/)(?:__generated__|codegen|generated)(?:\/|$)/u;
const GENERATED_FILENAME = /(?:^|\.)(?:codegen|generated|gen)(?:\.|$)/iu;
const SNAPSHOT_PATH = /(?:^|\/)(?:__snapshots__|snapshots)(?:\/|$)/u;
const SNAPSHOT_FILENAME = /\.snap$/iu;
const LOCKFILE_SUFFIX = /(?:\.lock(?:b|\.json|\.yaml)?|-lock(?:\.json|\.yaml)|\.lockfile)$/iu;

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: null,
    shell: false,
    stdio: 'pipe',
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString('utf8').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : '.'}`);
  }

  return result.stdout;
}

// Each staged file with the path it had at HEAD, so a renamed file keeps the
// exemption of the file it was.
function stagedFiles(root) {
  const fields = runGit(root, [
    'diff',
    '--cached',
    '--name-status',
    '-z',
    '-M',
    '--diff-filter=ACMR',
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const files = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index];
    if (status.startsWith('R') || status.startsWith('C')) {
      const [from, path] = fields.slice(index + 1, index + 3);
      files.push({ path, headPath: status.startsWith('R') ? from : path });
      index += 3;
    } else {
      files.push({ path: fields[index + 1], headPath: fields[index + 1] });
      index += 2;
    }
  }
  return files;
}

function shouldIgnore(path) {
  // The size policy applies to agent-authored source. These paths are owned by
  // package managers, generators, or test tooling instead.
  const fileName = path.slice(path.lastIndexOf('/') + 1);

  return (
    LOCKFILE_NAMES.has(fileName) ||
    LOCKFILE_SUFFIX.test(fileName) ||
    GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    GENERATED_PATH.test(path) ||
    GENERATED_FILENAME.test(fileName) ||
    SNAPSHOT_PATH.test(path) ||
    SNAPSHOT_FILENAME.test(fileName)
  );
}

function stagedBlob(root, path) {
  const result = spawnSync('git', ['cat-file', 'blob', `:${path}`], {
    cwd: root,
    encoding: null,
    maxBuffer: Number.POSITIVE_INFINITY,
    shell: false,
    stdio: 'pipe',
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString('utf8').trim();
    throw new Error(`git cat-file blob failed for ${path}${detail ? `: ${detail}` : '.'}`);
  }

  return result.stdout;
}

function committedBlobSize(root, path, revision = 'HEAD') {
  const result = spawnSync('git', ['cat-file', '-s', `${revision}:${path}`], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });

  if (result.status === 0) {
    const size = Number.parseInt(result.stdout, 10);
    if (Number.isFinite(size)) return size;
    throw new Error(`git cat-file -s returned an invalid size for ${revision}:${path}.`);
  }

  const head = spawnSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });
  if (head.status !== 0) return 0;

  const tree = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', revision, '--', path], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });
  if (tree.status === 0 && !tree.stdout.split('\0').includes(path)) return 0;

  const detail = result.error?.message ?? result.stderr?.trim();
  throw new Error(`git cat-file -s failed for ${revision}:${path}${detail ? `: ${detail}` : '.'}`);
}

function mergeParents(root) {
  // Git resolves the per-worktree merge state; no branch name implies a merge.
  const path = runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'])
    .toString('utf8')
    .trim();
  try {
    return readFileSync(path, 'utf8').trim().split(/\s+/u).filter(Boolean);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function isBinary(buffer) {
  return buffer.includes(0);
}

function formatTokens(bytes) {
  return (bytes / BYTES_PER_TOKEN).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });
}

function checkStagedFiles(root) {
  const oversized = [];
  const incomingParents = mergeParents(root);

  for (const { path, headPath } of stagedFiles(root)) {
    if (shouldIgnore(path)) continue;

    const blob = stagedBlob(root, path);
    if (!blob || isBinary(blob) || blob.length <= MAX_BYTES) continue;
    if (committedBlobSize(root, headPath) > MAX_BYTES) continue;
    if (incomingParents.some((parent) => committedBlobSize(root, path, parent) > MAX_BYTES))
      continue;

    oversized.push({ bytes: blob.length, path });
  }

  return oversized.sort((left, right) => left.path.localeCompare(right.path));
}

function main() {
  const root = runGit(process.cwd(), ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  const oversized = checkStagedFiles(root);
  if (oversized.length === 0) return;

  console.error(
    `Pre-commit blocked: staged files must be at most ${MAX_TOKENS.toLocaleString(
      'en-US',
    )} tokens (${MAX_BYTES.toLocaleString('en-US')} bytes; tokens = bytes / ${BYTES_PER_TOKEN}).`,
  );
  for (const { bytes, path } of oversized) {
    console.error(
      `  ${path}: ${formatTokens(bytes)} tokens (${bytes.toLocaleString('en-US')} bytes)`,
    );
  }
  console.error(`
Split each oversized file into focused modules before committing:
1. Move a cohesive component, helper, type, or feature into a new file.
2. Update imports and exports so each file stays at or below ${MAX_BYTES.toLocaleString('en-US')} bytes (${MAX_TOKENS.toLocaleString('en-US')} tokens).
3. Stage every new and changed file with \`git add\`, then retry the commit.`);
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
