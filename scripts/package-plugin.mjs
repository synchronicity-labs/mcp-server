// Builds the ChatGPT and Codex plugin package. The skills come from one pinned commit of
// synchronicity-labs/skills, never from this repository; see docs/chatgpt-plugin.md.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SOURCE_FILE = 'chatgpt-plugin/skills.source.json';
const DEFAULT_OUT = 'chatgpt-plugin-dist';
// Copied from chatgpt-plugin/ as they are; everything else in the package is skills.
const PLUGIN_FILES = ['.codex-plugin/plugin.json', '.mcp.json', 'assets/logo.png'];

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const skillName = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
const sourceSchema = z
  .object({
    repository: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/),
    commit: z.string().regex(/^[0-9a-f]{40}$/, 'commit must be a full 40-character SHA'),
    skills: z
      .array(
        z
          .object({
            name: skillName,
            // Appended to the skill's agents/openai.yaml; the skills repo sets no policy.
            policy: z.object({ allow_implicit_invocation: z.boolean() }).strict().optional(),
          })
          .strict(),
      )
      .min(1),
    // Skills in the repo that this package leaves out, each with the reason.
    excluded: z.record(skillName, z.string().min(1)),
  })
  .strict();

export function loadSource(root = ROOT) {
  const source = sourceSchema.parse(JSON.parse(readFileSync(resolve(root, SOURCE_FILE), 'utf8')));
  const names = [...source.skills.map((skill) => skill.name), ...Object.keys(source.excluded)];
  if (new Set(names).size !== names.length)
    throw new Error(`${SOURCE_FILE}: a skill is listed twice or both shipped and excluded.`);
  return source;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Checks out exactly `commit` of `repository` into a new directory and returns its path. */
export function fetchCommit(repository, commit) {
  const directory = mkdtempSync(join(tmpdir(), 'sync-skills-'));
  try {
    git(['init', '--quiet', directory]);
    git(['-C', directory, 'fetch', '--quiet', '--depth=1', '--no-tags', repository, commit]);
    const fetched = git(['-C', directory, 'rev-parse', 'FETCH_HEAD^{commit}']);
    if (fetched !== commit)
      throw new Error(`Fetched ${fetched} from ${repository}, not ${commit}.`);
    git(['-C', directory, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD']);
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Every regular file under `directory`, sorted, as paths relative to it. */
function filesUnder(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) return filesUnder(join(directory, entry.name), `${path}/`);
      if (!entry.isFile()) throw new Error(`${path}: skills may contain only regular files.`);
      return [path];
    })
    .sort(byCodeUnit);
}

function frontmatter(text, path) {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  if (!block) throw new Error(`${path}: missing frontmatter.`);
  return Object.fromEntries(
    block
      .split('\n')
      .filter((line) => /^[a-z][\w-]*:/.test(line))
      .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
  );
}

function checkSkill(folder, name) {
  const path = `skills/${name}`;
  if (!existsSync(join(folder, 'SKILL.md'))) throw new Error(`${path}: missing SKILL.md.`);
  const meta = frontmatter(readFileSync(join(folder, 'SKILL.md'), 'utf8'), `${path}/SKILL.md`);
  if (meta.name !== name) throw new Error(`${path}/SKILL.md: name is ${meta.name}, not ${name}.`);
  if (!meta.description || meta.description.length > 1024)
    throw new Error(`${path}/SKILL.md: description must be 1 to 1024 characters.`);
  if (!existsSync(join(folder, 'agents/openai.yaml')))
    throw new Error(`${path}: missing agents/openai.yaml.`);
  const ui = readFileSync(join(folder, 'agents/openai.yaml'), 'utf8');
  for (const field of ['display_name', 'short_description', 'default_prompt'])
    if (!new RegExp(`^ {2}${field}: ".+"$`, 'm').test(ui))
      throw new Error(`${path}/agents/openai.yaml: missing interface.${field}.`);
  if (!ui.includes(`$${name}`))
    throw new Error(`${path}/agents/openai.yaml: default_prompt does not name $${name}.`);
  const files = filesUnder(folder);
  // A skill is installed on its own, so every file it links to must be inside it.
  for (const file of files.filter((entry) => entry.endsWith('.md'))) {
    const text = readFileSync(join(folder, file), 'utf8');
    for (const [, link] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = link.split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const within = relative(folder, resolve(dirname(join(folder, file)), target));
      if (isAbsolute(within) || within.startsWith('..') || !files.includes(within))
        throw new Error(`${path}/${file}: links to ${target}, which the skill does not contain.`);
    }
  }
  return { ui, files };
}

function withPolicy(ui, policy, name) {
  if (!policy) return ui;
  if (/^policy:/m.test(ui))
    throw new Error(
      `skills/${name}/agents/openai.yaml sets a policy; drop it from ${SOURCE_FILE}.`,
    );
  const lines = Object.entries(policy).map(([key, value]) => `  ${key}: ${value}`);
  return `${ui.endsWith('\n') ? ui : `${ui}\n`}policy:\n${lines.join('\n')}\n`;
}

/**
 * Writes the plugin package to `out` from the checked-out skills repository at `checkout`.
 * Output depends only on the inputs, so two builds of one pin are byte-identical.
 */
export function packagePlugin({ root = ROOT, checkout, out = resolve(root, DEFAULT_OUT) }) {
  const source = loadSource(root);
  const available = readdirSync(join(checkout, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const listed = new Set([...source.skills.map((s) => s.name), ...Object.keys(source.excluded)]);
  const missing = [...listed].filter((name) => !available.includes(name));
  if (missing.length)
    throw new Error(`${source.commit} has no skills/${missing.join(', skills/')}.`);
  const unlisted = available.filter((name) => !listed.has(name));
  if (unlisted.length)
    throw new Error(
      `${source.commit} adds ${unlisted.join(', ')}: ship or exclude each in ${SOURCE_FILE}.`,
    );

  const plan = source.skills.map(({ name, policy }) => {
    const folder = join(checkout, 'skills', name);
    const { ui, files } = checkSkill(folder, name);
    return { name, folder, files, ui: withPolicy(ui, policy, name) };
  });

  rmSync(out, { recursive: true, force: true });
  for (const file of PLUGIN_FILES) {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    copyFileSync(join(root, 'chatgpt-plugin', file), join(out, file));
  }
  for (const { name, folder, files, ui } of plan) {
    for (const file of files) {
      const destination = join(out, 'skills', name, file);
      mkdirSync(dirname(destination), { recursive: true });
      if (file === 'agents/openai.yaml') writeFileSync(destination, ui);
      else copyFileSync(join(folder, file), destination);
    }
  }

  const manifest = JSON.parse(readFileSync(join(out, '.codex-plugin/plugin.json'), 'utf8'));
  if (manifest.skills !== './skills/') throw new Error('plugin.json must set skills to ./skills/.');
  const onboarding = manifest.extensions?.['com.openai']?.onboardingSkill;
  if (!onboarding || !existsSync(join(out, onboarding)))
    throw new Error(`plugin.json onboardingSkill ${onboarding} is not in the package.`);

  const files = filesUnder(out);
  const digest = createHash('sha256');
  for (const file of files) {
    const bytes = readFileSync(join(out, file));
    // The executable bit is part of the package (bundled scripts keep theirs).
    const mode = statSync(join(out, file)).mode & 0o111 ? '755' : '644';
    digest.update(`${file}\0${mode}\0${createHash('sha256').update(bytes).digest('hex')}\n`);
  }
  return {
    commit: source.commit,
    version: manifest.version,
    skills: plan.map((skill) => skill.name),
    files,
    digest: digest.digest('hex'),
  };
}

// Tool names are `<noun>_<verb>` (`lipsync_create`, `generations_get`; docs/tool-names.md).
// Names from before that rename, `<verb>-<noun>` (`create-lipsync`) and the `generate_` area,
// are still recognized so a skill that names one fails verification: in ChatGPT those are
// app-only aliases the model cannot call. The areas and verbs are fixed here, not read from
// the allowlist, so a name stays recognizable after its last tool is removed;
// verify-plugin-package.mjs fails when a hosted tool fits neither scheme.
const TOOL_AREAS = [
  'account',
  'analytics',
  'app',
  'assets',
  'audio-trims',
  'batches',
  'billing-approval-links',
  'dialogue',
  'dialogue-edits',
  'dialogue-previews',
  'dialogue-transcriptions',
  'dialogue-videos',
  'dubbing',
  'feedback',
  'generate',
  'generations',
  'jobs',
  'lipsync',
  'models',
  'organizations',
  'projects',
  'scenes',
  'speech-previews',
  'stems',
  'sync-app',
  'studio-drafts',
  'studio-views',
  'transcriptions',
  'translation-previews',
  'tts',
  'tts-jobs',
  'voices',
];
const TOOL_VERBS = [
  'ack',
  'cancel',
  'clone',
  'continue',
  'create',
  'delete',
  'estimate',
  'get',
  'list',
  'open',
  'refresh',
  'register',
  'rename',
  'save',
  'send',
  'show',
  'track',
  'trim',
  'update',
  'upload',
  'wait',
];
const TOOL_NAME = new RegExp(
  `^(?:(?:${TOOL_AREAS.join('|')})_|(?:${TOOL_VERBS.join('|')})-)[a-z0-9]+(?:-[a-z0-9]+)*$`,
);

/** Whether `name` follows one of the server's tool naming schemes. */
export const isToolName = (name) => TOOL_NAME.test(name);

/**
 * Backticked names in `text` that look like a server tool but that `tools` doesn't list.
 * Field names such as `sync_mode` or `success_count`, values such as `lipsync-2` and the names
 * in `skills` don't look like tools, so they never count.
 */
export function unlistedTools(text, tools, skills = []) {
  const named = [...text.matchAll(/`([a-z][a-z0-9_-]*)`/g)].map((m) => m[1]);
  const toolLike = named.filter((name) => isToolName(name) && !skills.includes(name));
  return [...new Set(toolLike)].filter((name) => !tools.has(name)).sort(byCodeUnit);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = loadSource();
  const checkout = fetchCommit(source.repository, source.commit);
  try {
    const result = packagePlugin({ checkout });
    console.log(
      `Packaged plugin ${result.version} into ${DEFAULT_OUT}/ from ${source.repository}@${result.commit}`,
    );
    console.log(`Skills (${result.skills.length}): ${result.skills.join(', ')}`);
    console.log(`${result.files.length} files, sha256 ${result.digest}`);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}
