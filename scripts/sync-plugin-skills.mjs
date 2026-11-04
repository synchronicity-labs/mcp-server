import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesUnder, ROOT, validateSkillFiles } from './skill-files.mjs';

export function syncPluginSkills({ root = ROOT, check = false } = {}) {
  const { skills } = validateSkillFiles(root);
  const changes = [];
  for (const skill of skills.filter((entry) => entry.plugin)) {
    const source = resolve(root, 'skills', skill.name);
    const target = resolve(root, 'chatgpt-plugin/skills', skill.plugin.name);
    const expected = new Map(
      filesUnder(source).map((file) => {
        const bytes = readFileSync(resolve(source, file));
        return [
          file,
          file === 'SKILL.md'
            ? Buffer.from(
                bytes.toString('utf8').replace(/^name:.*$/m, `name: ${skill.plugin.name}`),
              )
            : bytes,
        ];
      }),
    );
    expected.set('agents/openai.yaml', Buffer.from(skill.plugin.interfaceYaml));
    for (const file of filesUnder(target)) {
      if (expected.has(file)) continue;
      changes.push(`${skill.plugin.name}/${file} (stale)`);
      if (!check) rmSync(resolve(target, file));
    }
    for (const [file, bytes] of expected) {
      const destination = resolve(target, file);
      if (existsSync(destination) && readFileSync(destination).equals(bytes)) continue;
      changes.push(`${skill.plugin.name}/${file}`);
      if (!check) {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, bytes);
      }
    }
  }
  const extra = filesUnder(resolve(root, 'chatgpt-plugin/skills')).filter(
    (file) => !skills.some((s) => s.plugin && file.startsWith(`${s.plugin.name}/`)),
  );
  if (extra.length) throw new Error(`Uncatalogued plugin files: ${extra.join(', ')}`);
  if (check && changes.length)
    throw new Error(`Run pnpm skills:sync-plugin; stale plugin files:\n${changes.join('\n')}`);
  return changes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const changes = syncPluginSkills({ check: process.argv.includes('--check') });
  console.log(
    `Plugin skills ${process.argv.includes('--check') ? 'checked' : 'generated'}: ${changes.length} changed files.`,
  );
}
