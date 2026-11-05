#!/usr/bin/env node
// Keeps server.json, the official MCP Registry listing, publishable:
//   node scripts/check-server-json.mjs [base-server.json]
// exits 1, printing each problem, when server.json's version differs from
// package.json's, or when server.json differs from [base-server.json] (the base
// branch's copy) under the same version. The registry never replaces a published
// version, so a listing change under an old version would never reach it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export function serverJsonProblems(server, packageVersion, base) {
  const problems = [];
  if (server.version !== packageVersion) {
    problems.push(
      `server.json version ${server.version} must match package.json version ${packageVersion}.`,
    );
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
      readJson('package.json').version,
      basePath ? readJson(basePath) : undefined,
    );
    for (const problem of problems) console.log(problem);
    if (problems.length > 0) process.exitCode = 1;
  }
}
