import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseDistTag, compareStable, highestStable, latestTagProblem } from './npm-dist-tag.mjs';

void test('compares stable versions numerically, not as text', () => {
  assert.ok(compareStable('0.10.0', '0.9.9') > 0);
  assert.ok(compareStable('1.0.0', '0.99.99') > 0);
  assert.ok(compareStable('0.2.0', '0.2.1') < 0);
  assert.equal(compareStable('0.2.0', '0.2.0+build.1'), 0);
});

void test('ignores prereleases when finding the highest stable version', () => {
  assert.equal(highestStable(['0.1.4', '0.3.0-beta.1', '0.2.0']), '0.2.0');
  assert.equal(highestStable(['0.3.0-beta.1']), undefined);
  assert.equal(highestStable([]), undefined);
});

void test('gives latest only to a version above every published stable version', () => {
  assert.equal(chooseDistTag('0.2.0', ['0.1.3', '0.1.4']), 'latest');
  assert.equal(chooseDistTag('0.1.0', []), 'latest');
  assert.equal(chooseDistTag('0.2.0', ['0.1.4', '0.3.0-beta.1']), 'latest');
});

void test('keeps an older version that finishes late off latest', () => {
  assert.equal(chooseDistTag('0.2.0', ['0.1.4', '0.3.0']), 'previous');
  assert.equal(chooseDistTag('0.2.0', ['0.2.0']), 'previous');
});

void test('publishes prereleases under next', () => {
  assert.equal(chooseDistTag('0.3.0-beta.1', ['0.2.0']), 'next');
  assert.equal(chooseDistTag('1.0.0-rc.1+build.5', []), 'next');
});

void test('reports a latest tag behind the highest stable version, with the fix', () => {
  const packument = {
    'dist-tags': { latest: '0.2.0' },
    versions: { '0.1.4': {}, '0.2.0': {}, '0.3.0': {}, '0.4.0-beta.1': {} },
  };
  const problem = latestTagProblem(packument);
  assert.match(problem ?? '', /latest tag points at 0\.2\.0/);
  assert.match(problem ?? '', /npm dist-tag add @sync\.so\/mcp-server@0\.3\.0 latest/);
});

void test('accepts a latest tag on the highest stable version', () => {
  const packument = {
    'dist-tags': { latest: '0.3.0', next: '0.4.0-beta.1' },
    versions: { '0.2.0': {}, '0.3.0': {}, '0.4.0-beta.1': {} },
  };
  assert.equal(latestTagProblem(packument), undefined);
  assert.equal(latestTagProblem({ versions: {} }), undefined);
});
