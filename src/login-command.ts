import { finishEmailLogin, LoginError, startEmailLogin } from './auth/email-code-login.js';
import { loadCredentials } from './auth/token-store.js';
import { PACKAGE_VERSION } from './version.js';

const COMMAND = 'npx -y @sync.so/mcp-server@latest';

const USAGE = `Usage:
  sync-mcp login --email <address> [--agent <name>]   Email a sign-in code
  sync-mcp login --code <code>                        Finish with the emailed code

Signs in without a browser. --agent names the agent in the emails sync. sends
(for example "Claude Code"). A code connects the account's personal workspace.
`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** Who the new sign-in acts for, to confirm it to the person. Best effort. */
async function describeAccount(baseUrl: string): Promise<string> {
  try {
    const credentials = await loadCredentials();
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v2/account`, {
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

async function login(args: string[], baseUrl: string): Promise<string> {
  const email = option(args, '--email');
  const code = option(args, '--code');
  if (email) {
    const started = await startEmailLogin({
      baseUrl,
      email,
      agentName: option(args, '--agent'),
      registrationUrl: process.env.SYNC_MCP_REGISTRATION_URL,
    });
    return `Sent a sign-in code to ${started.email}. It expires in ${started.expiresInMinutes} minutes.
Ask the person for the code in that email, then run:
  ${COMMAND} login --code <code>
`;
  }
  if (code) {
    const finished = await finishEmailLogin({ baseUrl, code });
    const account = await describeAccount(baseUrl);
    return `Signed in to sync. as ${finished.email}${account ? ` (${account})` : ''}.
If the sync. server is not added to your agent yet, add it with the command "${COMMAND}", for example:
  claude mcp add sync -- ${COMMAND}
Then start a new session so the sync. tools load.
`;
  }
  throw new LoginError(USAGE);
}

/** `sync-mcp login`: prints the result for the agent to relay, and returns the exit code. */
export async function runLogin(args: string[], baseUrl: string): Promise<number> {
  try {
    process.stdout.write(await login(args, baseUrl));
    return 0;
  } catch (error) {
    if (!(error instanceof LoginError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}
