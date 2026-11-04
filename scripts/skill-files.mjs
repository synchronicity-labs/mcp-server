import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const name = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    skills: z
      .array(
        z
          .object({
            name,
            title: z.string().min(1),
            availability: z.string().min(1),
            plugin: z.object({ name, interfaceYaml: z.string().min(1) }).nullable(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export function loadCatalog(root = ROOT) {
  const catalog = catalogSchema.parse(
    JSON.parse(readFileSync(resolve(root, 'skills/catalog.json'), 'utf8')),
  );
  for (const values of [
    catalog.skills.map((s) => s.name),
    catalog.skills.flatMap((s) => (s.plugin ? [s.plugin.name] : [])),
  ]) {
    if (new Set(values).size !== values.length) throw new Error('Duplicate skill or plugin name.');
  }
  return catalog;
}

export function readSkill(path) {
  const text = readFileSync(path, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${path}: missing YAML frontmatter.`);
  const meta = z
    .object({ name, description: z.string().trim().min(1).max(1024) })
    .passthrough()
    .parse(parse(match[1]));
  return { text, meta };
}

export function filesUnder(directory, prefix = '') {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix + entry.name;
      if (entry.isSymbolicLink())
        throw new Error(`${directory}/${entry.name}: skill resources cannot be symlinks.`);
      if (entry.isDirectory()) return filesUnder(resolve(directory, entry.name), `${path}/`);
      if (!entry.isFile()) throw new Error(`Unsupported resource: ${path}`);
      return [path];
    })
    .sort((a, b) => a.localeCompare(b));
}

export function validateSkillFiles(root = ROOT) {
  const catalog = loadCatalog(root);
  const actual = readdirSync(resolve(root, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  if (
    JSON.stringify(actual) !==
    JSON.stringify(catalog.skills.map((s) => s.name).sort((a, b) => a.localeCompare(b)))
  )
    throw new Error('Skill directories differ from catalog.');
  for (const skill of catalog.skills) {
    const folder = resolve(root, 'skills', skill.name);
    const { meta } = readSkill(resolve(folder, 'SKILL.md'));
    if (meta.name !== skill.name)
      throw new Error(`${skill.name}: frontmatter name differs from directory.`);
    for (const file of filesUnder(folder).filter((f) => f.endsWith('.md'))) {
      const path = resolve(folder, file);
      const text = readFileSync(path, 'utf8');
      if (/\[TODO:|\bTBD\b/.test(text)) throw new Error(`${path}: unfinished scaffold.`);
      for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1].split('#')[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const destination = resolve(dirname(path), decodeURIComponent(target));
        const rel = relative(folder, destination);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || !existsSync(destination))
          throw new Error(`${path}: missing or external skill resource ${target}.`);
      }
    }
    if (skill.plugin) {
      const ui = z
        .object({
          interface: z.object({
            display_name: z.string(),
            short_description: z.string(),
            default_prompt: z.string(),
          }),
        })
        .passthrough()
        .parse(parse(skill.plugin.interfaceYaml));
      if (!ui.interface.default_prompt.includes(`$${skill.plugin.name}`))
        throw new Error(`${skill.name}: plugin prompt names the wrong skill.`);
    }
  }
  return catalog;
}

export function tableTools(text) {
  return [
    ...new Set(
      text
        .split('\n')
        .filter((line) => line.startsWith('| '))
        .flatMap((line) =>
          [...line.matchAll(/`([a-z][a-z0-9]*(?:[-_][a-z0-9]+)+)`/g)].map((m) => m[1]),
        ),
    ),
  ];
}
