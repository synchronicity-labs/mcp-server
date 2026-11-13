import { type AddResult, addToAgent, detectAgent, manualAdd } from './agent-install.js';
import {
  apiUrl,
  finishEmailLogin,
  LoginError,
  packageCommand,
  startEmailLogin,
} from './auth/email-code-login.js';
import { loadCredentials } from './auth/token-store.js';
import { PACKAGE_VERSION } from './version.js';

/** `setup` signs in and adds the server to the agent; `login` only signs in. */
export type LoginCommand = 'login' | 'setup';

const USAGE = `Usage:
  sync-mcp setup --email <address> [--agent <name>]   Email a sign-in code
  sync-mcp setup --code <code>                        Sign in and add the server to your agent
  sync-mcp login --email <address> [--agent <name>]   Email a sign-in code
  sync-mcp login --code <code>                        Sign in only

Signs in without a browser. --agent names the agent in the emails sync. sends
(for example "Claude Code"); it is detected in Claude Code and Codex. A code
connects the account's personal workspace.
`;

const NEW_SESSION = 'Start a new session so the sync. tools load.';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** Who the new sign-in acts for, to confirm it to the person. Best effort. */
async function describeAccount(baseUrl: string): Promise<string> {
  try {
    const credentials = await loadCredentials();
    const response = await fetch(apiUrl(baseUrl, 'v2/account'), {
      headers: {
        Authorization: `Bearer ${credentials?.token}`,
        'x-sync-source': 'mcp',
        'x-sync-mcp-version': PACKAGE_VERSION,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const account = (await response.json()) as {
      organization?: { name?: string | null };
      plan?: { name?: string };
    };
    const workspace = account.organization?.name;
    const plan = account.plan?.name;
    return [workspace ? `workspace "${workspace}"` : '', plan ? `${plan} plan` : '']
      .filter(Boolean)
      .join(', ');
  } catch {
    return '';
  }
}

/** How the server reached the agent, or what the person's agent still has to run. */
function installed(result: AddResult, server: string): string {
  if (result.outcome !== 'manual') {
    return result.outcome === 'added'
      ? `Added the sync. server to ${result.agent} for every project.\n${NEW_SESSION}`
      : `The sync. server was already added to ${result.agent}.\nIf its tools are not loaded, start a new session.`;
  }
  const commands = result.commands.map((line) => `  ${line}`).join('\n');
  return result.agent
    ? `Add the sync. server to ${result.agent} with:\n${commands}\n${NEW_SESSION}`
    : `Add the sync. server to your agent: it runs the command "${server}" over stdio. For example:\n${commands}\n${NEW_SESSION}`;
}

type Install = typeof addToAgent;

async function login(
  command: LoginCommand,
  args: string[],
  baseUrl: string,
  install: Install,
): Promise<string> {
  const email = option(args, '--email');
  const code = option(args, '--code');
  if (email) {
    const started = await startEmailLogin({
      baseUrl,
      email,
      agentName: option(args, '--agent') ?? detectAgent(),
      registrationUrl: process.env.SYNC_MCP_REGISTRATION_URL,
    });
    return `Sent a sign-in code to ${started.email}. It expires in ${started.expiresInMinutes} minutes.
Ask the person for the code in that email, then run:
  ${packageCommand(baseUrl, `${command} --code <code>`)}
`;
  }
  if (code) {
    const finished = await finishEmailLogin({ baseUrl, code });
    const account = await describeAccount(baseUrl);
    const server = packageCommand(baseUrl);
    const agent = option(args, '--agent') ?? finished.agentName;
    const result = command === 'setup' ? await install(agent, server) : manualAdd(agent, server);
    return `Signed in to sync. as ${finished.email}${account ? ` (${account})` : ''}.
${installed(result, server)}
`;
  }
  throw new LoginError(USAGE);
}

/** `sync-mcp setup` and `login`: prints the result for the agent to relay; returns the exit code. */
export async function runLogin(
  command: LoginCommand,
  args: string[],
  baseUrl: string,
  install: Install = addToAgent,
): Promise<number> {
  try {
    process.stdout.write(await login(command, args, baseUrl, install));
    return 0;
  } catch (error) {
    if (!(error instanceof LoginError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}
