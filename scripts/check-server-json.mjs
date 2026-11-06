#!/usr/bin/env node
// Keeps server.json, the official MCP Registry listing, publishable:
//   node scripts/check-server-json.mjs [base-server.json]
// exits 1, printing each problem, when server.json's version differs from
// package.json's, when an npm package entry names another package or version or
// package.json lacks the matching mcpName (the registry checks both against npm),
// or when server.json differs from [base-server.json] (the base branch's copy)
// under the same version. The registry never replaces a published version, so a
// listing change under an old version would never reach it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export function serverJsonProblems(server, pkg, base) {
  const problems = [];
  if (server.version !== pkg.version) {
    problems.push(
      `server.json version ${server.version} must match package.json version ${pkg.version}.`,
    );
  }
  for (const entry of server.packages ?? []) {
    if (entry.registryType !== 'npm') continue;
    if (entry.identifier !== pkg.name || entry.version !== pkg.version) {
      problems.push(
        `server.json npm package ${entry.identifier}@${entry.version} must be ` +
          `package.json's ${pkg.name}@${pkg.version}.`,
      );
    }
    if (pkg.mcpName !== server.name) {
      problems.push(`package.json mcpName must be ${server.name} for the registry to verify npm.`);
    }
  }
  if (base && base.version === server.version && !isDeepStrictEqual(base, server)) {
    problems.push(
      `server.json changed but kept the base branch's version ${server.version}, ` +
        'and the registry never replaces a published version. ' +
        'Bump the version in package.json and server.json together.',
    );
  }
  return problems;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [basePath, ...rest] = process.argv.slice(2);
  if (rest.length > 0) {
    console.error('Usage: check-server-json.mjs [base-server.json]');
    process.exitCode = 2;
  } else {
    const problems = serverJsonProblems(
      readJson('server.json'),
      readJson('package.json'),
      basePath ? readJson(basePath) : undefined,
    );
    for (const problem of problems) console.log(problem);
    if (problems.length > 0) process.exitCode = 1;
  }
}
