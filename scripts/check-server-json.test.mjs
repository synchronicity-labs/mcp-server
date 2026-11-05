import assert from 'node:assert/strict';
import test from 'node:test';
import { serverJsonProblems } from './check-server-json.mjs';

const listing = { name: 'io.github.synchronicity-labs/mcp-server', version: '0.2.0' };

void test('accepts a listing on the package version', () => {
  assert.deepEqual(serverJsonProblems(listing, '0.2.0'), []);
  assert.deepEqual(serverJsonProblems(listing, '0.2.0', listing), []);
});

void test('accepts a listing change that bumps the version', () => {
  const base = { ...listing, version: '0.1.4', description: 'Old copy' };
  assert.deepEqual(serverJsonProblems(listing, '0.2.0', base), []);
});

void test('rejects a version that drifts from package.json', () => {
  assert.equal(serverJsonProblems(listing, '0.2.1').length, 1);
});

void test('rejects a listing change that keeps the published version', () => {
  const base = { ...listing, description: 'Old copy' };
  const [problem] = serverJsonProblems(listing, '0.2.0', base);
  assert.match(problem, /kept the base branch's version 0\.2\.0/);
});
