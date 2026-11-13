import { describe, expect, it } from 'vitest';
import { addSkills, addToAgent, detectAgent, manualAdd } from './agent-install.js';

const SERVER = 'npx -y @sync.so/mcp-server@latest';
const CLAUDE = `claude mcp add --scope user sync -- ${SERVER}`;
const CODEX = `codex mcp add sync -- ${SERVER}`;

describe('adding the server to the agent', () => {
  it.each([
    [{ CLAUDECODE: '1' }, 'Claude Code'],
    [{ CODEX_THREAD_ID: 'thread-1' }, 'Codex'],
    [{}, undefined],
  ])('detects the agent from its shell: %j', (env, agent) => {
    expect(detectAgent(env)).toBe(agent);
  });

  it('adds the server for every project with the named agent’s own command', async () => {
    const runs: string[] = [];
    const run = async (binary: string, args: string[]) => {
      runs.push([binary, ...args].join(' '));
      return { ok: true, output: '' };
    };

    await expect(addToAgent('Claude Code', SERVER, run, {})).resolves.toEqual({
      agent: 'Claude Code',
      outcome: 'added',
    });
    await expect(
      addToAgent('Codex CLI', `${SERVER} --base-url https://api.test`, run, {}),
    ).resolves.toEqual({ agent: 'Codex', outcome: 'added' });
    expect(runs).toEqual([CLAUDE, `${CODEX} --base-url https://api.test`]);
  });

  it.each(['claude-code', 'claudecode', 'Claude', 'CLAUDE CODE'])(
    'knows the agent however it spells its name: %s',
    async (name) => {
      const run = async () => ({ ok: true, output: '' });

      await expect(addToAgent(name, SERVER, run, {})).resolves.toEqual({
        agent: 'Claude Code',
        outcome: 'added',
      });
    },
  );

  it('falls back to the agent whose shell this is when the name says nothing', async () => {
    const run = async () => ({ ok: true, output: '' });

    await expect(
      addToAgent('sync. MCP server', SERVER, run, { CODEX_THREAD_ID: 'thread-1' }),
    ).resolves.toEqual({ agent: 'Codex', outcome: 'added' });
    await expect(addToAgent(undefined, SERVER, run, { CLAUDECODE: '1' })).resolves.toEqual({
      agent: 'Claude Code',
      outcome: 'added',
    });
  });

  it('says so when the agent already has the server', async () => {
    const run = async () => ({
      ok: false,
      output: 'MCP server sync already exists in user config',
    });

    await expect(addToAgent('Claude Code', SERVER, run, {})).resolves.toEqual({
      agent: 'Claude Code',
      outcome: 'exists',
    });
  });

  it('hands back the command when the agent’s own command fails', async () => {
    const run = async () => ({ ok: false, output: 'spawn claude ENOENT' });

    await expect(addToAgent('Claude Code', SERVER, run, {})).resolves.toEqual({
      agent: 'Claude Code',
      outcome: 'manual',
      commands: [CLAUDE],
    });
  });

  it('runs nothing for an agent it does not know, and lists the known commands', async () => {
    const run = async () => {
      throw new Error('ran a command for an unknown agent');
    };

    await expect(addToAgent('Cursor', SERVER, run, {})).resolves.toEqual({
      outcome: 'manual',
      commands: [CLAUDE, CODEX],
    });
    expect(manualAdd('Codex', SERVER, {})).toEqual({
      agent: 'Codex',
      outcome: 'manual',
      commands: [CODEX],
    });
  });

  it('adds the sync. skills for every project with the agent’s name in the skills installer', async () => {
    const runs: string[] = [];
    const run = async (binary: string, args: string[]) => {
      runs.push([binary, ...args].join(' '));
      return { ok: true, output: '' };
    };

    await expect(addSkills('claude-code', run, {})).resolves.toEqual({
      agent: 'Claude Code',
      outcome: 'added',
    });
    await expect(addSkills(undefined, run, { CODEX_THREAD_ID: 't' })).resolves.toEqual({
      agent: 'Codex',
      outcome: 'added',
    });
    expect(runs).toEqual([
      'npx -y skills add synchronicity-labs/skills -g -y -a claude-code -s *',
      'npx -y skills add synchronicity-labs/skills -g -y -a codex -s *',
    ]);
  });

  it('hands back the skills command when the installer fails or the agent is not known', async () => {
    const failing = async () => ({ ok: false, output: 'network' });
    const never = async () => {
      throw new Error('ran the installer for an unknown agent');
    };

    await expect(addSkills('Codex', failing, {})).resolves.toEqual({
      agent: 'Codex',
      outcome: 'manual',
      commands: ["npx -y skills add synchronicity-labs/skills -g -y -a codex -s '*'"],
    });
    await expect(addSkills('Cursor', never, {})).resolves.toEqual({
      outcome: 'manual',
      commands: ["npx -y skills add synchronicity-labs/skills -g -s '*'"],
    });
  });
});
