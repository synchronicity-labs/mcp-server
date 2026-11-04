import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveClientProfile } from './client-profile.js';
import { resolveConfig } from './config.js';
import { SERVER_INSTRUCTIONS, serverDescription, serverInstructions } from './server.js';
import {
  DESCRIPTION_EDITS,
  INSTRUCTION_EDITS,
  parseSpendConfirmation,
  TOOL_DESCRIPTION_EDITS,
  UNATTENDED_INSTRUCTIONS_PREFIX,
  withoutSpendConfirmation,
} from './spend-confirmation.js';

const here = import.meta.dirname;
const sources = [here, join(here, 'tools')]
  .flatMap((dir) =>
    readdirSync(dir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => join(dir, file)),
  )
  .filter((file) => !file.endsWith('spend-confirmation.ts'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

describe('unattended spend mode', () => {
  it('finds every sentence it removes, so rewording a description cannot silently undo it', () => {
    for (const [from] of INSTRUCTION_EDITS) expect(SERVER_INSTRUCTIONS).toContain(from);
    for (const [from] of DESCRIPTION_EDITS) expect(serverDescription()).toContain(from);
    for (const [tool, edits] of Object.entries(TOOL_DESCRIPTION_EDITS))
      for (const [from] of edits) expect(sources, `${tool}: ${from}`).toContain(from);
  });

  it('keeps the default instructions and drops quoting and approval prose when off', () => {
    const profile = resolveClientProfile('claude-code');
    expect(serverInstructions(profile)).toBe(serverInstructions(profile, true));
    const unattended = serverInstructions(profile, false);
    expect(unattended.startsWith(UNATTENDED_INSTRUCTIONS_PREFIX)).toBe(true);
    expect(unattended).not.toMatch(/estimate and confirm|re-quote|Before quoting|displayed cost/i);
    expect(unattended).toContain('create-translate-and-dub');
    expect(serverDescription(false)).not.toContain('cost');
  });

  it('rewrites only the tools it names', () => {
    const tool = {
      name: 'create-timeline-lipsync',
      description: 'Estimate and confirm before creating; this starts a generation.',
      inputSchema: {},
      handler: async () => ({}),
    };
    expect(withoutSpendConfirmation(tool).description).toBe('This starts a generation.');
    const other = { ...tool, name: 'projects_get' };
    expect(withoutSpendConfirmation(other)).toBe(other);
  });

  it('reads the operator setting from the environment, CLI overrides first', () => {
    expect(parseSpendConfirmation(undefined)).toBeUndefined();
    expect(parseSpendConfirmation('OFF')).toBe(false);
    expect(parseSpendConfirmation('1')).toBe(true);
    expect(() => parseSpendConfirmation('maybe')).toThrow('must be on or off');
    const previous = process.env.SYNC_MCP_SPEND_CONFIRMATION;
    try {
      process.env.SYNC_MCP_SPEND_CONFIRMATION = 'off';
      expect(resolveConfig().spendConfirmation).toBe(false);
      expect(resolveConfig({ spendConfirmation: true }).spendConfirmation).toBe(true);
      delete process.env.SYNC_MCP_SPEND_CONFIRMATION;
      expect(resolveConfig().spendConfirmation).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SYNC_MCP_SPEND_CONFIRMATION;
      else process.env.SYNC_MCP_SPEND_CONFIRMATION = previous;
    }
  });
});
