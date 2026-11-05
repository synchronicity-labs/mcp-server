// Checks the built plugin package (pnpm run build && pnpm run package:plugin first).
// Packaged skills outlive deploys, so a skill that names a tool the hosted server no longer
// lists breaks silently in ChatGPT and Codex; fail here instead.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unlistedTools } from './package-plugin.mjs';

const { HOSTED_HTTP_TOOL_ALLOWLIST } = await import(pathToFileURL(resolve('dist/server.js')));
const root = resolve(process.argv[2] ?? 'chatgpt-plugin-dist');
const markdown = (directory) =>
  readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');

const skills = readdirSync(join(root, 'skills')).sort();
const problems = skills.flatMap((skill) =>
  unlistedTools(markdown(join(root, 'skills', skill)), HOSTED_HTTP_TOOL_ALLOWLIST).map(
    (tool) => `${skill} names ${tool}, which the hosted server does not list`,
  ),
);
if (problems.length) throw new Error(problems.join('\n'));
console.log(`${skills.length} packaged skills name only hosted tools.`);
