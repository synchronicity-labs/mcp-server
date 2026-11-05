import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Skills are packaged from synchronicity-labs/skills; `pnpm run package:plugin` and
// `pnpm run verify:plugin` check them. This covers what the repository itself holds.
const root = join(import.meta.dirname, '..', 'chatgpt-plugin');
const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
const source = JSON.parse(readFileSync(join(root, 'skills.source.json'), 'utf8'));

describe('ChatGPT plugin package', () => {
  it('points the manifest at files the package contains', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(join(root, manifest.mcpServers))).toBe(true);
    expect(existsSync(join(root, manifest.interface.logo))).toBe(true);
    expect(manifest.interface.defaultPrompt.length).toBeLessThanOrEqual(3);
    // The publisher blocks submission when the subtitle is longer.
    expect(manifest.interface.shortDescription.length).toBeLessThanOrEqual(30);
  });

  it('onboards with a packaged skill that only runs when asked', () => {
    const onboarding = /^\.\/skills\/([a-z0-9-]+)\/SKILL\.md$/.exec(
      manifest.extensions['com.openai'].onboardingSkill,
    )?.[1];
    const entry = source.skills.find((skill: { name: string }) => skill.name === onboarding);
    expect(entry?.policy).toEqual({ allow_implicit_invocation: false });
  });

  it('keeps no skill content in this repository', () => {
    expect(existsSync(join(root, 'skills'))).toBe(false);
  });
});
