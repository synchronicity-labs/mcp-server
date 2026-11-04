import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { planDeployment } from './plan-skill-deploy.mjs';
import { deployStartFrom, waitForNewProcess } from './smoke-deploy.mjs';

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-deploy-plan-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const commit = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
    git('add', '-A');
    git('commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const live = commit('src/server.ts', 'original runtime\n');
  return { cwd, git, commit, live };
}

void test('skills-only ranges skip and smoke-check the served revision without a new process', async (t) => {
  const repo = repository(t);
  repo.commit('skills/sync-lipsync/SKILL.md', 'instructions\n');
  const target = repo.commit('docs/skills.md', 'installation\n');
  const plan = planDeployment({ cwd: repo.cwd, liveRevision: repo.live, targetRevision: target });
  assert.deepEqual(plan, {
    deploy: false,
    targetRevision: target,
    expectedRevision: repo.live,
    reason: 'skills-only',
  });
  const health = await waitForNewProcess({
    baseUrl: 'https://example.invalid',
    expectedRevision: plan.expectedRevision,
    deployStartedAt: deployStartFrom({ allowExisting: !plan.deploy }),
    timeoutMs: 1,
    intervalMs: 1,
    fetchImpl: async () =>
      Response.json({ status: 'ok', revision: repo.live, startedAt: '2020-01-01T00:00:00Z' }),
  });
  assert.equal(health.revision, repo.live);
});

void test('an earlier undeployed runtime change is not hidden by a later skills commit', (t) => {
  const repo = repository(t);
  repo.commit('src/server.ts', 'new runtime\n');
  const target = repo.commit('skills/sync-account/SKILL.md', 'new instructions\n');
  const plan = planDeployment({ cwd: repo.cwd, liveRevision: repo.live, targetRevision: target });
  assert.equal(plan.deploy, true);
  assert.equal(plan.expectedRevision, target);
  assert.equal(plan.reason, 'runtime-changes');
});

void test('runtime files renamed into skills still deploy', (t) => {
  const repo = repository(t);
  mkdirSync(join(repo.cwd, 'skills'), { recursive: true });
  repo.git('mv', 'src/server.ts', 'skills/server.ts');
  repo.git('commit', '-m', 'rename');
  const target = repo.git('rev-parse', 'HEAD');
  assert.equal(
    planDeployment({ cwd: repo.cwd, liveRevision: repo.live, targetRevision: target }).deploy,
    true,
  );
});

void test('unknown or divergent production history deploys; an unavailable target fails', (t) => {
  const repo = repository(t);
  const target = repo.commit('README.md', 'docs\n');
  for (const liveRevision of [undefined, 'unknown', 'f'.repeat(40)]) {
    assert.equal(
      planDeployment({ cwd: repo.cwd, liveRevision, targetRevision: target }).deploy,
      true,
    );
  }
  repo.git('checkout', '-b', 'divergent', repo.live);
  const divergent = repo.commit('elsewhere.txt', 'separate commit\n');
  assert.equal(
    planDeployment({ cwd: repo.cwd, liveRevision: divergent, targetRevision: target }).deploy,
    true,
  );
  assert.throws(
    () =>
      planDeployment({ cwd: repo.cwd, liveRevision: repo.live, targetRevision: 'f'.repeat(40) }),
    /available commit/,
  );
});

void test('already-current revision is checked without deployment, while unknown paths deploy', (t) => {
  const repo = repository(t);
  assert.equal(
    planDeployment({ cwd: repo.cwd, liveRevision: repo.live, targetRevision: repo.live }).reason,
    'already-current',
  );
  for (const path of ['package.json', '.github/workflows/deploy.yml', 'Dockerfile']) {
    const target = repo.commit(path, 'changed\n');
    assert.equal(
      planDeployment({ cwd: repo.cwd, liveRevision: repo.live, targetRevision: target }).deploy,
      true,
    );
  }
});
