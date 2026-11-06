#!/usr/bin/env node
// Asks Greptile to review a pull request head once (.github/workflows/greptile-review.yml):
//   node scripts/request-greptile-review.mjs <pr-number> <head-sha>
// Reads the PR and the head's checks live, after the workflow's wait, so a PR
// closed, marked draft or pushed to in the meantime gets no paid request.
// Needs GH_TOKEN and GITHUB_REPOSITORY, as in GitHub Actions.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Why no review should be requested for `sha`, or null to request one. */
export function skipReason(pull, sha, greptileChecks) {
  if (pull.state !== 'open') return `#${pull.number} is ${pull.state}.`;
  if (pull.draft) return `#${pull.number} is a draft.`;
  if (pull.head.sha !== sha)
    return `#${pull.number} moved to ${pull.head.sha}; that push's run requests its review.`;
  if (greptileChecks > 0) return `Greptile already reviewed ${sha}.`;
  return null;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [number, sha, ...rest] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^\d+$/.test(number ?? '') || !/^[0-9a-f]{40}$/.test(sha ?? '') || rest.length || !repo) {
    console.error(
      'Usage: GITHUB_REPOSITORY=owner/name request-greptile-review.mjs <pr-number> <head-sha>',
    );
    process.exitCode = 2;
  } else {
    const pull = JSON.parse(gh(['api', `repos/${repo}/pulls/${number}`]));
    const checks = JSON.parse(
      gh([
        'api',
        `repos/${repo}/commits/${sha}/check-runs?check_name=Greptile%20Review&per_page=1`,
      ]),
    ).total_count;
    const reason = skipReason(pull, sha, checks);
    if (reason) {
      console.log(`::notice::${reason} No review requested.`);
    } else {
      gh(['pr', 'comment', number, '--repo', repo, '--body', '@greptileai']);
      console.log(`Requested a Greptile review of ${sha}.`);
    }
  }
}
