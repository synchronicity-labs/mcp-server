import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { fetchCommit, packagePlugin, unlistedTools } from './package-plugin.mjs';

function put(root, path, text, mode = 0o644) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, { mode });
}

const skill = (name, body = '') => `---\nname: ${name}\ndescription: Does ${name}.\n---\n${body}`;
const ui = (name) =>
  `interface:\n  display_name: "${name}"\n  short_description: "About ${name}"\n  default_prompt: "Use $${name}."\n`;

/** A skills repository with one commit, served over file:// like a remote. */
function skillsRepository(t, files) {
  const directory = mkdtempSync(join(tmpdir(), 'skills-repo-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Bundled scripts are committed executable, as in the skills repository.
  for (const [path, text] of Object.entries(files))
    put(directory, path, text, path.endsWith('.py') ? 0o755 : 0o644);
  const run = (...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  run('init', '--quiet');
  run('add', '.');
  run('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '--quiet', '-m', 'skills');
  return { url: pathToFileURL(directory).href, commit: run('rev-parse', 'HEAD') };
}

const upstream = {
  'skills/setup/SKILL.md': skill('setup', 'See [connect](references/connect.md).\n'),
  'skills/setup/agents/openai.yaml': ui('setup'),
  'skills/setup/references/connect.md': 'Connect steps.\n',
  'skills/batch/SKILL.md': skill('batch', 'Run [the script](scripts/run.py#usage).\n'),
  'skills/batch/agents/openai.yaml': ui('batch'),
  'skills/batch/scripts/run.py': 'print("run")\n',
  'skills/internal/SKILL.md': skill('internal'),
  'skills/internal/agents/openai.yaml': ui('internal'),
  'README.md': 'Not packaged.\n',
};

function pluginRoot(t, commit, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = {
    repository: 'https://github.com/synchronicity-labs/skills',
    commit,
    skills: [{ name: 'setup', policy: { allow_implicit_invocation: false } }, { name: 'batch' }],
    excluded: { internal: 'Not for this package.' },
    ...overrides,
  };
  put(root, 'chatgpt-plugin/skills.source.json', JSON.stringify(source));
  put(
    root,
    'chatgpt-plugin/.codex-plugin/plugin.json',
    JSON.stringify({
      version: '1.0.0',
      skills: './skills/',
      extensions: { 'com.openai': { onboardingSkill: './skills/setup/SKILL.md' } },
    }),
  );
  put(root, 'chatgpt-plugin/.mcp.json', '{}\n');
  put(root, 'chatgpt-plugin/assets/logo.png', 'png');
  return root;
}

function checkoutOf(t, repository, commit) {
  const checkout = fetchCommit(repository, commit);
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  return checkout;
}

void test('packages whole skill folders from the pinned commit, byte for byte', (t) => {
  const repo = skillsRepository(t, upstream);
  const root = pluginRoot(t, repo.commit);
  const out = join(root, 'out');
  const first = packagePlugin({ root, checkout: checkoutOf(t, repo.url, repo.commit), out });

  assert.deepEqual(first.skills, ['setup', 'batch']);
  assert.deepEqual(first.files, [
    '.codex-plugin/plugin.json',
    '.mcp.json',
    'assets/logo.png',
    'skills/batch/SKILL.md',
    'skills/batch/agents/openai.yaml',
    'skills/batch/scripts/run.py',
    'skills/setup/SKILL.md',
    'skills/setup/agents/openai.yaml',
    'skills/setup/references/connect.md',
  ]);
  assert.equal(
    readFileSync(join(out, 'skills/setup/SKILL.md'), 'utf8'),
    upstream['skills/setup/SKILL.md'],
  );
  assert.equal(
    readFileSync(join(out, 'skills/setup/agents/openai.yaml'), 'utf8'),
    `${ui('setup')}policy:\n  allow_implicit_invocation: false\n`,
  );
  assert.equal(readFileSync(join(out, 'skills/batch/agents/openai.yaml'), 'utf8'), ui('batch'));

  const again = packagePlugin({ root, checkout: checkoutOf(t, repo.url, repo.commit), out });
  assert.equal(again.digest, first.digest);
  assert.ok(statSync(join(out, 'skills/batch/scripts/run.py')).mode & 0o100);
});

void test('refuses a commit the repository does not have', (t) => {
  const repo = skillsRepository(t, upstream);
  assert.throws(() => fetchCommit(repo.url, 'a'.repeat(40)));
});

const failures = [
  {
    name: 'a shipped skill missing at the pin',
    files: { ...upstream, 'skills/batch/SKILL.md': undefined },
    error: /missing SKILL\.md/,
  },
  {
    name: 'an upstream skill neither shipped nor excluded',
    files: { ...upstream, 'skills/new/SKILL.md': skill('new') },
    error: /adds new: ship or exclude/,
  },
  {
    name: 'a link to a file the skill does not contain',
    files: { ...upstream, 'skills/setup/references/connect.md': undefined },
    error: /links to references\/connect\.md/,
  },
  {
    name: 'a link outside the skill folder',
    files: { ...upstream, 'skills/batch/SKILL.md': skill('batch', '[readme](../../README.md)\n') },
    error: /links to \.\.\/\.\.\/README\.md/,
  },
  {
    name: 'a frontmatter name that differs from its folder',
    files: { ...upstream, 'skills/batch/SKILL.md': skill('lipsync-batch') },
    error: /name is lipsync-batch, not batch/,
  },
  {
    name: 'an upstream policy that the source would duplicate',
    files: { ...upstream, 'skills/setup/agents/openai.yaml': `${ui('setup')}policy:\n  x: 1\n` },
    error: /sets a policy/,
  },
];

for (const { name, files, error } of failures) {
  void test(`fails closed on ${name}`, (t) => {
    const present = Object.fromEntries(Object.entries(files).filter(([, text]) => text));
    const repo = skillsRepository(t, present);
    const root = pluginRoot(t, repo.commit);
    const out = join(root, 'out');
    assert.throws(
      () => packagePlugin({ root, checkout: checkoutOf(t, repo.url, repo.commit), out }),
      error,
    );
  });
}

void test('fails closed on a skill that is both shipped and excluded', (t) => {
  const repo = skillsRepository(t, upstream);
  const root = pluginRoot(t, repo.commit, { excluded: { batch: 'x', internal: 'y' } });
  assert.throws(
    () => packagePlugin({ root, checkout: checkoutOf(t, repo.url, repo.commit) }),
    /listed twice or both shipped and excluded/,
  );
});

void test('fails closed on an abbreviated commit', (t) => {
  const repo = skillsRepository(t, upstream);
  const root = pluginRoot(t, repo.commit.slice(0, 12));
  assert.throws(
    () => packagePlugin({ root, checkout: checkoutOf(t, repo.url, repo.commit) }),
    /full 40-character SHA/,
  );
});

void test('flags tool-shaped names the server does not list, not field names', () => {
  const tools = new Set(['create-lipsync', 'generate_get-generation', 'batches_create']);
  const text =
    'Call `create-lipsync`, then `generate_get-generation`. Set `sync_mode` and `cut_off`. ' +
    'Old names: `create-lipsync-video`, `generate_get-generations`, `batches_get`.';
  assert.deepEqual(unlistedTools(text, tools), [
    'batches_get',
    'create-lipsync-video',
    'generate_get-generations',
  ]);
});
