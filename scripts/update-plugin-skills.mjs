// Pins chatgpt-plugin/skills.source.json to the skills repository's current main (or to
// --commit <sha>), then builds the package from the new pin to prove it still packages.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fetchCommit, loadSource, packagePlugin, ROOT, SOURCE_FILE } from './package-plugin.mjs';

const source = loadSource();
const requested = process.argv[process.argv.indexOf('--commit') + 1];
const commit = process.argv.includes('--commit')
  ? requested
  : execFileSync('git', ['ls-remote', source.repository, 'refs/heads/main'], { encoding: 'utf8' })
      .split('\t')[0]
      .trim();
if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error(`Not a full commit SHA: ${commit}`);

const checkout = fetchCommit(source.repository, commit);
try {
  const upstream = readdirSync(join(checkout, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const listed = new Set([...source.skills.map((s) => s.name), ...Object.keys(source.excluded)]);
  const added = upstream.filter((name) => !listed.has(name));
  const removed = [...listed].filter((name) => !upstream.includes(name));
  if (added.length) console.log(`New upstream skills to ship or exclude: ${added.join(', ')}`);
  if (removed.length) console.log(`Skills removed upstream: ${removed.join(', ')}`);

  const path = resolve(ROOT, SOURCE_FILE);
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, text.replace(`"commit": "${source.commit}"`, `"commit": "${commit}"`));
  if (loadSource().commit !== commit) throw new Error(`Could not update the commit in ${path}.`);
  console.log(
    commit === source.commit
      ? `Already pinned to ${commit}.`
      : `Pinned ${commit} (was ${source.commit}).`,
  );
  const result = packagePlugin({ checkout });
  console.log(`Packaged ${result.skills.length} skills: ${result.skills.join(', ')}`);
} finally {
  rmSync(checkout, { recursive: true, force: true });
}
