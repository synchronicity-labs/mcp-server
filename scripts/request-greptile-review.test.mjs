import assert from 'node:assert/strict';
import test from 'node:test';
import { skipReason } from './request-greptile-review.mjs';

const sha = 'a'.repeat(40);
const pull = { number: 7, state: 'open', draft: false, head: { sha } };

void test('requests a review for an open, ready head with no Greptile check', () => {
  assert.equal(skipReason(pull, sha, 0), null);
});

void test('skips a PR closed during the wait', () => {
  assert.match(skipReason({ ...pull, state: 'closed' }, sha, 0), /is closed/);
});

void test('skips a PR marked draft during the wait', () => {
  assert.match(skipReason({ ...pull, draft: true }, sha, 0), /is a draft/);
});

void test('skips a head that a newer push replaced', () => {
  const moved = { ...pull, head: { sha: 'b'.repeat(40) } };
  assert.match(skipReason(moved, sha, 0), /moved to b+/);
});

void test('skips a head Greptile already reviewed', () => {
  assert.match(skipReason(pull, sha, 1), /already reviewed/);
});
