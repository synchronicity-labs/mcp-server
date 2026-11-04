import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{40}$/i;

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function skillPath(path) {
  return (
    path === 'README.md' ||
    path === 'docs/skills.md' ||
    ['skills/', 'docs/skills/', 'chatgpt-plugin/skills/'].some((prefix) => path.startsWith(prefix))
  );
}

/** Compare the complete undeployed range, preserving the revision actually served on a skip. */
export function planDeployment({ cwd = process.cwd(), liveRevision, targetRevision }) {
  if (
    !SHA.test(targetRevision ?? '') ||
    git(cwd, ['cat-file', '-e', `${targetRevision}^{commit}`]).status !== 0
  )
    throw new Error('The selected deployment target must be an available commit SHA.');
  const deploy = (reason) => ({
    deploy: true,
    targetRevision,
    expectedRevision: targetRevision,
    reason,
  });
  if (!SHA.test(liveRevision ?? '')) return deploy('live-revision-unavailable');
  if (liveRevision === targetRevision)
    return {
      deploy: false,
      targetRevision,
      expectedRevision: liveRevision,
      reason: 'already-current',
    };
  const ancestor = git(cwd, ['merge-base', '--is-ancestor', liveRevision, targetRevision]);
  if (ancestor.status !== 0) return deploy('history-unavailable-or-divergent');
  // With renames disabled, both the deleted and added paths must qualify.
  const diff = git(cwd, [
    'diff',
    '--no-ext-diff',
    '--no-renames',
    '--name-only',
    '-z',
    liveRevision,
    targetRevision,
  ]);
  if (diff.status !== 0) return deploy('diff-unavailable');
  const paths = diff.stdout.split('\0').filter(Boolean);
  if (!paths.every(skillPath)) return deploy('runtime-changes');
  return { deploy: false, targetRevision, expectedRevision: liveRevision, reason: 'skills-only' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plan = planDeployment({
    liveRevision: process.env.LIVE_REVISION,
    targetRevision: process.env.TARGET_REVISION,
  });
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `deploy=${plan.deploy}`,
        `sha=${plan.targetRevision}`,
        `sha_short=${plan.targetRevision.slice(0, 12)}`,
        `expected_revision=${plan.expectedRevision}`,
        `reason=${plan.reason}`,
        '',
      ].join('\n'),
    );
  console.log(JSON.stringify(plan));
}
