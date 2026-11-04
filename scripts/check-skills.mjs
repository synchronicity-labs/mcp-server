import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { filesUnder, ROOT, tableTools, validateSkillFiles } from './skill-files.mjs';
import { syncPluginSkills } from './sync-plugin-skills.mjs';

const catalog = validateSkillFiles();
const coverage = JSON.parse(readFileSync(resolve(ROOT, 'docs/skills/coverage.json'), 'utf8'));
const known = new Set(coverage.tools.map((t) => t.name));
const names = new Set(catalog.skills.map((s) => s.name));
if (known.size !== coverage.tools.length) throw new Error('Duplicate tool coverage.');
for (const tool of coverage.tools) {
  if (!names.has(tool.owner)) throw new Error(`${tool.name}: unknown owner ${tool.owner}.`);
  if (
    tool.kind === 'widget-internal' &&
    (!tool.protocolTest || !existsSync(resolve(ROOT, tool.protocolTest)))
  )
    throw new Error(`${tool.name}: missing widget protocol test owner.`);
}
for (const skill of catalog.skills) {
  const folder = resolve(ROOT, 'skills', skill.name);
  const referenced = filesUnder(folder)
    .filter((f) => f.endsWith('.md'))
    .flatMap((f) => tableTools(readFileSync(resolve(folder, f), 'utf8')));
  for (const tool of referenced)
    if (!known.has(tool)) throw new Error(`${skill.name}: unclassified tool ${tool}.`);
  for (const tool of coverage.tools.filter((entry) => entry.owner === skill.name))
    if (!referenced.includes(tool.name))
      throw new Error(`${skill.name}: owned tool ${tool.name} has no documented workflow.`);
}
syncPluginSkills({ check: true });
console.log(
  `Validated ${catalog.skills.length} skills, plugin resources and ${known.size} classified tools.`,
);
