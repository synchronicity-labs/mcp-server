import assert from 'node:assert/strict';
import test from 'node:test';
import { diffCaptures, sortKeys } from './capture-wire.mjs';

void test('reports no differences for captures equal up to key order', () => {
  const capture = { http: { clients: { a: { tools: [{ name: 't', title: 'x' }] } } } };
  const reordered = sortKeys({ http: { clients: { a: { tools: [{ title: 'x', name: 't' }] } } } });
  assert.deepEqual(diffCaptures(capture, reordered), []);
});

void test('names the exact path of each changed, added or removed value', () => {
  const before = { clients: { claude: { tools: ['a', 'b'], version: '0.1.0' }, gone: 1 } };
  const after = { clients: { claude: { tools: ['a', 'b'], version: '0.1.4' }, added: 2 } };
  assert.deepEqual(diffCaptures(before, after), [
    { path: '/clients/added', before: undefined, after: 2 },
    { path: '/clients/claude/version', before: '0.1.0', after: '0.1.4' },
    { path: '/clients/gone', before: 1, after: undefined },
  ]);
});

void test('reports a changed list length once instead of every shifted item', () => {
  const differences = diffCaptures({ tools: ['a', 'b', 'c'] }, { tools: ['a', 'c'] });
  assert.deepEqual(differences, [{ path: '/tools.length', before: 3, after: 2 }]);
});
