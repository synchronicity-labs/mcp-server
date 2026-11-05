#!/usr/bin/env node
// Keeps npm's `latest` tag on the highest stable version when publishes overlap
// (.github/workflows/publish.yml runs different versions in parallel):
//   node scripts/npm-dist-tag.mjs choose <version> <packument.json>
//     prints the dist-tag to publish <version> under
//   node scripts/npm-dist-tag.mjs check <packument.json>
//     exits 1, printing the fix, when `latest` is not the highest stable version
// <packument.json> is the registry's document for the package, e.g.
// https://registry.npmjs.org/@sync.so%2fmcp-server
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@sync.so/mcp-server';

export function isPrerelease(version) {
  return version.split('+')[0].includes('-');
}

function numbers(version) {
  return version.split('+')[0].split('.').map(Number);
}

/** Positive when stable version `a` is higher than stable version `b`. */
export function compareStable(a, b) {
  const [x, y] = [numbers(a), numbers(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function highestStable(versions) {
  let highest;
  for (const version of versions) {
    if (isPrerelease(version)) continue;
    if (highest === undefined || compareStable(version, highest) > 0) highest = version;
  }
  return highest;
}

/**
 * Prereleases go to `next`. A stable version takes `latest` only when it is
 * higher than every stable version already published. An older one, which can
 * finish after a newer one when two version bumps merge close together, goes
 * to `previous` so `latest` never moves backwards.
 */
export function chooseDistTag(version, publishedVersions) {
  if (isPrerelease(version)) return 'next';
  const highest = highestStable(publishedVersions);
  return highest === undefined || compareStable(version, highest) > 0 ? 'latest' : 'previous';
}

/**
 * Two runs that both chose `latest` before either published can still finish
 * in the wrong order. Returns how to repair that, or undefined when `latest`
 * is the highest stable version.
 */
export function latestTagProblem(packument) {
  const highest = highestStable(Object.keys(packument.versions ?? {}));
  const latest = packument['dist-tags']?.latest;
  if (highest === undefined || latest === highest) return undefined;
  return (
    `npm's latest tag points at ${latest}, but the highest stable version is ${highest}. ` +
    `An npm maintainer should run: npm dist-tag add ${PACKAGE}@${highest} latest`
  );
}

function readPackument(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'choose' && args.length === 2) {
    const [version, path] = args;
    console.log(chooseDistTag(version, Object.keys(readPackument(path).versions ?? {})));
  } else if (command === 'check' && args.length === 1) {
    const problem = latestTagProblem(readPackument(args[0]));
    if (problem) {
      console.log(problem);
      process.exitCode = 1;
    }
  } else {
    console.error(
      'Usage: npm-dist-tag.mjs choose <version> <packument.json> | check <packument.json>',
    );
    process.exitCode = 2;
  }
}
