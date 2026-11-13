import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddResult } from './agent-install.js';
import { type LoginCommand, runLogin } from './login-command.js';

const API = 'https://api.test';
const SERVER = `npx -y @sync.so/mcp-server@latest --base-url ${API}`;

let home: string;
let printed: string;
let refused: string;
let installs: [agent: string | undefined, server: string][];

const REPLIES: Record<string, unknown> = {
  '/register': { client_id: 'client-1' },
  '/v2/oauth/email-code': { request_id: 'request-1', expires_in: 600 },
  '/v2/oauth/email-code/token': {
    access_token: 'oat-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
  },
  '/v2/account': { organization: { name: 'personal' }, plan: { name: 'Free' } },
};

/** Runs the command against the stub API; `added` is what adding to the agent returns. */
function run(command: LoginCommand, args: string[], added?: AddResult): Promise<number> {
  return runLogin(command, args, API, async (agent, server) => {
    installs.push([agent, server]);
    return added ?? { agent: 'Claude Code', outcome: 'added' };
  });
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-mcp-setup-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('SYNC_MCP_REGISTRATION_URL', 'https://mcp.test/register');
  vi.stubEnv('CLAUDECODE', '');
  vi.stubEnv('CODEX_THREAD_ID', '');
  printed = '';
  refused = '';
  installs = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
    printed += String(text);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
    refused += String(text);
    return true;
  });
  vi.stubGlobal('fetch', async (url: string) => {
    const reply = REPLIES[new URL(url).pathname];
    return new Response(JSON.stringify(reply ?? {}), { status: reply ? 200 : 404 });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe('sync-mcp setup and login', () => {
  it('setup signs in, then adds the server to the agent it was started in', async () => {
    vi.stubEnv('CLAUDECODE', '1');

    expect(await run('setup', ['--email', 'person@example.com'])).toBe(0);
    expect(printed).toContain(SERVER.replace(' --base-url', ' setup --code <code> --base-url'));
    expect(installs).toEqual([]);

    printed = '';
    expect(await run('setup', ['--code', '123456'])).toBe(0);
    expect(installs).toEqual([['Claude Code', SERVER]]);
    expect(printed).toBe(
      'Signed in to sync. as person@example.com (workspace "personal", Free plan).\n' +
        'Added the sync. server to Claude Code for every project.\n' +
        'Start a new session so the sync. tools load.\n',
    );
  });

  it('setup says when the agent already had the server', async () => {
    await run('setup', ['--email', 'person@example.com', '--agent', 'Claude Code']);
    printed = '';

    await run('setup', ['--code', '123456'], { agent: 'Claude Code', outcome: 'exists' });

    expect(printed).toContain('The sync. server was already added to Claude Code.');
  });

  it('setup prints the command when it could not add the server itself', async () => {
    await run('setup', ['--email', 'person@example.com', '--agent', 'Codex']);
    printed = '';

    await run('setup', ['--code', '123456'], {
      agent: 'Codex',
      outcome: 'manual',
      commands: [`codex mcp add sync -- ${SERVER}`],
    });

    expect(printed).toContain(
      `Add the sync. server to Codex with:\n  codex mcp add sync -- ${SERVER}`,
    );
  });

  it('login signs in without touching the agent, and prints its command', async () => {
    await run('login', ['--email', 'person@example.com', '--agent', 'Claude Code']);
    expect(printed).toContain('login --code <code>');
    printed = '';

    expect(await run('login', ['--code', '123456'])).toBe(0);

    expect(installs).toEqual([]);
    expect(printed).toContain(
      `Add the sync. server to Claude Code with:\n  claude mcp add --scope user sync -- ${SERVER}`,
    );
  });

  it('lists every known command for an agent it does not know', async () => {
    await run('login', ['--email', 'person@example.com', '--agent', 'Cursor']);
    printed = '';

    await run('login', ['--code', '123456']);

    expect(printed).toContain(`it runs the command "${SERVER}" over stdio`);
    expect(printed).toContain(`  claude mcp add --scope user sync -- ${SERVER}`);
    expect(printed).toContain(`  codex mcp add sync -- ${SERVER}`);
  });

  it('prints the usage and fails when neither step is asked for', async () => {
    expect(await run('setup', [])).toBe(1);
    expect(refused).toContain('sync-mcp setup --email <address>');
    expect(printed).toBe('');
  });
});
