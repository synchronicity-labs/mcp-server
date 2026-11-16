import { describe, expect, it } from 'vitest';
import { resolveClientProfile } from './client-profile.js';
import { INSTRUCTIONS_OPENING, serverInstructions } from './server.js';
import { toolsetInstruction } from './toolsets.js';

// How much of a server's instructions each client is sure to hand its model. ChatGPT and
// Codex: the first 512 characters. Claude Code: 4,096, and 2,048 before v2.1.296.
const OPENING = 512;
const OLDER_CLAUDE_CODE = 2048;
const CLAUDE_CODE = 4096;

const CLIENTS = ['openai-mcp', 'openai-mcp (codex)', 'claude-ai', 'claude-code', 'cursor'];
const instructionsFor = (client: string) => serverInstructions(resolveClientProfile(client));
/** Where the paragraph holding `phrase` ends, or -1 when this client is not sent it. */
const endOf = (instructions: string, phrase: string) => {
  const at = instructions.indexOf(phrase);
  return at < 0 ? -1 : at + phrase.length;
};

describe('server instructions fit what clients keep', () => {
  it('opens every client with one self-contained paragraph of rules, not tone', () => {
    expect(INSTRUCTIONS_OPENING.length).toBeLessThanOrEqual(OPENING);
    for (const client of CLIENTS)
      expect(instructionsFor(client).startsWith(INSTRUCTIONS_OPENING), client).toBe(true);
    for (const rule of ['paid create', 'Create once', 'new project', 'nextAction'])
      expect(INSTRUCTIONS_OPENING).toContain(rule);
  });

  it('keeps waiting on a generation and the shot review card inside the older Claude Code cut', () => {
    for (const client of CLIENTS) {
      const instructions = instructionsFor(client);
      const waits = endOf(instructions, 'never say you will watch the job or report back');
      expect(waits, client).toBeGreaterThan(0);
      expect(waits, client).toBeLessThan(OLDER_CLAUDE_CODE);
      expect(endOf(instructions, 'not in a page you write.'), client).toBeLessThan(
        OLDER_CLAUDE_CODE,
      );
    }
  });

  it('keeps every rule that spans tools inside the Claude Code cut', () => {
    for (const client of CLIENTS) {
      const instructions = instructionsFor(client);
      for (const phrase of [
        'Never resend a refused request unchanged.',
        'only offer another capability if a corresponding tool is actually available.',
        'Write lipsync as one word, without a hyphen.',
        'do not perform the suggested action unless the user requests it.',
      ]) {
        const end = endOf(instructions, phrase);
        expect(end, `${client}: ${phrase}`).toBeGreaterThan(0);
        expect(end, `${client}: ${phrase}`).toBeLessThan(CLAUDE_CODE);
      }
    }
  });

  it('puts what a local install must be told before the paragraphs a client may cut', () => {
    const toolsets = toolsetInstruction(undefined);
    const instructions = serverInstructions(
      resolveClientProfile('claude-code'),
      true,
      true,
      { current: '0.3.24', latest: '0.3.25' },
      toolsets,
    );
    for (const note of ['version 0.3.25 is available', toolsets, 'call feedback_send once']) {
      const end = endOf(instructions, note);
      expect(end, note).toBeGreaterThan(0);
      expect(end, note).toBeLessThan(CLAUDE_CODE);
    }
  });
});
