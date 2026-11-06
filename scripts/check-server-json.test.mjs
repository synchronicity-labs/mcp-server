import assert from 'node:assert/strict';
import test from 'node:test';
import { serverJsonProblems } from './check-server-json.mjs';

const listing = { name: 'io.github.synchronicity-labs/mcp-server', version: '0.2.0' };
const pkg = { name: '@sync.so/mcp-server', version: '0.2.0', mcpName: listing.name };
const npmEntry = { registryType: 'npm', identifier: pkg.name, version: '0.2.0' };

void test('accepts a listing on the package version', () => {
  assert.deepEqual(serverJsonProblems(listing, pkg), []);
  assert.deepEqual(serverJsonProblems(listing, pkg, listing), []);
});

void test('accepts a listing change that bumps the version', () => {
  const base = { ...listing, version: '0.1.4', description: 'Old copy' };
  assert.deepEqual(serverJsonProblems(listing, pkg, base), []);
});

void test('rejects a version that drifts from package.json', () => {
  assert.equal(serverJsonProblems(listing, { ...pkg, version: '0.2.1' }).length, 1);
});

void test('rejects a listing change that keeps the published version', () => {
  const base = { ...listing, description: 'Old copy' };
  const [problem] = serverJsonProblems(listing, pkg, base);
  assert.match(problem, /kept the base branch's version 0\.2\.0/);
});

void test('accepts an npm package entry for this package and version', () => {
  assert.deepEqual(serverJsonProblems({ ...listing, packages: [npmEntry] }, pkg), []);
});

void test('rejects an npm package entry on another version or without mcpName', () => {
  const server = { ...listing, packages: [{ ...npmEntry, version: '0.1.4' }] };
  assert.match(
    serverJsonProblems(server, pkg)[0],
    /must be package\.json's @sync\.so\/mcp-server@0\.2\.0/,
  );
  const { mcpName: _, ...withoutMcpName } = pkg;
  assert.match(
    serverJsonProblems({ ...listing, packages: [npmEntry] }, withoutMcpName)[0],
    /mcpName/,
  );
});
