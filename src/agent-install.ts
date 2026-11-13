import { execFile } from 'node:child_process';

/**
 * Adds this server to the agent that runs `setup`, with the agent's own command, so the
 * person copies nothing. Only agents whose command is known are run; any other agent is
 * told what to add.
 */

type Agent = {
  name: string;
  /** Set in the shells this agent runs commands in. */
  marker: string;
  binary: string;
  /** Arguments that add `server` for every project, not only the current folder. */
  add: (server: string[]) => string[];
};

const AGENTS: readonly Agent[] = [
  {
    name: 'Claude Code',
    marker: 'CLAUDECODE',
    binary: 'claude',
    add: (server) => ['mcp', 'add', '--scope', 'user', 'sync', '--', ...server],
  },
  {
    name: 'Codex',
    marker: 'CODEX_THREAD_ID',
    binary: 'codex',
    add: (server) => ['mcp', 'add', 'sync', '--', ...server],
  },
];

const ADD_TIMEOUT_MS = 30_000;

export type AddResult =
  | { agent: string; outcome: 'added' | 'exists' }
  /** Not added: the commands to run by hand, for this agent or for each known one. */
  | { agent?: string; outcome: 'manual'; commands: string[] };

type Run = (binary: string, args: string[]) => Promise<{ ok: boolean; output: string }>;

const runBinary: Run = (binary, args) =>
  new Promise((resolve) => {
    execFile(binary, args, { timeout: ADD_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}${stderr}` });
    });
  });

/** The agent whose shell this is, when it says so. */
export function detectAgent(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return AGENTS.find((agent) => env[agent.marker])?.name;
}

function known(name: string | undefined): Agent | undefined {
  const wanted = name?.trim().toLowerCase();
  return wanted ? AGENTS.find((agent) => wanted.includes(agent.name.toLowerCase())) : undefined;
}

const commandLine = (agent: Agent, server: string[]) =>
  [agent.binary, ...agent.add(server)].join(' ');

/** The commands to run by hand: the named agent's, or every known one when it is not known. */
export function manualAdd(agentName: string | undefined, serverCommand: string): AddResult {
  const server = serverCommand.split(' ');
  const agent = known(agentName);
  return {
    ...(agent ? { agent: agent.name } : {}),
    outcome: 'manual',
    commands: (agent ? [agent] : AGENTS).map((each) => commandLine(each, server)),
  };
}

/** Adds the server to the named agent, or returns the commands when it cannot. */
export async function addToAgent(
  agentName: string | undefined,
  serverCommand: string,
  run: Run = runBinary,
): Promise<AddResult> {
  const agent = known(agentName);
  if (!agent) return manualAdd(agentName, serverCommand);
  const result = await run(agent.binary, agent.add(serverCommand.split(' ')));
  if (result.ok) return { agent: agent.name, outcome: 'added' };
  if (/already exists/i.test(result.output)) return { agent: agent.name, outcome: 'exists' };
  return manualAdd(agentName, serverCommand);
}
