import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOSTED_HTTP_TOOL_ALLOWLIST } from './server.js';

const root = join(import.meta.dirname, '..', 'chatgpt-plugin');
const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
const skills = readdirSync(join(root, 'skills'));

function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  return Object.fromEntries(
    block.split('\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
}

describe('ChatGPT plugin package', () => {
  it('points the manifest at files the package contains', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(join(root, manifest.mcpServers))).toBe(true);
    expect(existsSync(join(root, manifest.interface.logo))).toBe(true);
    expect(existsSync(join(root, manifest.extensions['com.openai'].onboardingSkill))).toBe(true);
    expect(manifest.interface.defaultPrompt.length).toBeLessThanOrEqual(3);
    // The publisher blocks submission when the subtitle is longer.
    expect(manifest.interface.shortDescription.length).toBeLessThanOrEqual(30);
  });

  it.each(skills)('%s names itself and has a display interface', (skill) => {
    const meta = frontmatter(readFileSync(join(root, 'skills', skill, 'SKILL.md'), 'utf8'));
    expect(meta.name).toBe(skill);
    expect(skill).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(meta.description?.length).toBeGreaterThan(0);
    expect(meta.description!.length).toBeLessThanOrEqual(1024);
    const ui = readFileSync(join(root, 'skills', skill, 'agents', 'openai.yaml'), 'utf8');
    expect(ui).toMatch(/^ {2}display_name: ".+"$/m);
    expect(ui).toMatch(/^ {2}short_description: ".+"$/m);
  });

  // Published skills outlive deploys, so a renamed or unlisted tool would break them silently.
  it.each(skills)('%s only references tools the hosted server lists', (skill) => {
    const text = readFileSync(join(root, 'skills', skill, 'SKILL.md'), 'utf8');
    const tableTools = text
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Step'))
      .flatMap((line) => [...line.matchAll(/`([a-z][a-z_-]+)`/g)].map((match) => match[1]!));
    const calledTools = [...text.matchAll(/(?:Call|call|use|Poll|poll) `([a-z][a-z_-]+)`/g)].map(
      (match) => match[1]!,
    );
    const referenced = new Set([...tableTools, ...calledTools]);
    expect([...referenced].filter((tool) => !HOSTED_HTTP_TOOL_ALLOWLIST.has(tool))).toEqual([]);
    expect(tableTools.length).toBeGreaterThan(0);
  });
});
