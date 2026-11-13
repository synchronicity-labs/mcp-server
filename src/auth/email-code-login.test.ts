import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emailLoginAuth,
  finishEmailLogin,
  packageCommand,
  savedEmailLogin,
  startEmailLogin,
} from './email-code-login.js';
import { loadCredentials, loadToken, saveCredentials, saveToken } from './token-store.js';

const API = 'https://api.test';
const REGISTER = 'https://mcp.test/register';

type Call = { url: string; body: Record<string, unknown> };
type Reply = { status?: number; body?: unknown; retryAfter?: string };

let home: string;
let calls: Call[];
const call = (index: number) => calls[index] as Call;

/** Answers each request from the reply for its path; `replies` may change between calls. */
function api(replies: Record<string, Reply | (() => Reply | Promise<Reply>)>) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
    const match = replies[new URL(url).pathname];
    if (!match) throw new Error(`unexpected request to ${url}`);
    const reply = typeof match === 'function' ? await match() : match;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: reply.retryAfter ? { 'Retry-After': reply.retryAfter } : {},
    });
  });
}

const started = { body: { request_id: 'request-1', expires_in: 600 } };
const registered = { body: { client_id: 'client-1', token_endpoint_auth_method: 'none' } };
const tokens = (name: string) => ({
  body: { access_token: `oat-${name}`, refresh_token: `refresh-${name}`, expires_in: 3600 },
});
const pendingFile = () => path.join(home, '.config', 'sync', 'mcp-login.json');
const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

const start = (overrides: Partial<Parameters<typeof startEmailLogin>[0]> = {}) =>
  startEmailLogin({
    baseUrl: API,
    email: 'person@example.com',
    agentName: 'Claude Code',
    registrationUrl: REGISTER,
    ...overrides,
  });

const EMAIL = 'person@example.com';
// One running server's view of the sign-in: the account it started with.
const auth = () => emailLoginAuth({ baseUrl: API, email: EMAIL })();

const expiredLogin = (baseUrl = API) =>
  saveCredentials({
    token: 'oat-old',
    refreshToken: 'refresh-old',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    clientId: 'client-1',
    clientName: 'Claude Code',
    email: EMAIL,
    baseUrl,
  });

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-mcp-login-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  calls = [];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe('signing in by emailed code', () => {
  it('registers a public client named for the agent, then emails the code', async () => {
    api({ '/register': registered, '/v2/oauth/email-code': started });

    await expect(start()).resolves.toEqual({ email: 'person@example.com', expiresInMinutes: 10 });

    expect(call(0)).toMatchObject({
      url: REGISTER,
      body: {
        client_name: 'Claude Code',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
      },
    });
    expect(call(1).body).toMatchObject({
      client_id: 'client-1',
      email: 'person@example.com',
      code_challenge_method: 'S256',
    });
    expect(call(1).body.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('finishes with the code, saves a refreshable sign-in and forgets the request', async () => {
    api({
      '/register': registered,
      '/v2/oauth/email-code': started,
      '/v2/oauth/email-code/token': tokens('first'),
    });
    await start();

    await expect(finishEmailLogin({ baseUrl: API, code: ' 123456 ' })).resolves.toEqual({
      email: 'person@example.com',
    });

    expect(call(2).body).toMatchObject({
      client_id: 'client-1',
      request_id: 'request-1',
      code: '123456',
    });
    expect(await loadCredentials()).toMatchObject({
      token: 'oat-first',
      refreshToken: 'refresh-first',
      clientId: 'client-1',
      email: EMAIL,
      baseUrl: API,
    });
    expect(await exists(pendingFile())).toBe(false);
  });

  it('leaves a newer sign-in waiting when an older one finishes after it started', async () => {
    let request = 0;
    api({
      '/register': registered,
      '/v2/oauth/email-code': () => ({
        body: { request_id: `request-${++request}`, expires_in: 600 },
      }),
      '/v2/oauth/email-code/token': async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return tokens('first');
      },
    });
    await start();

    const finishing = finishEmailLogin({ baseUrl: API, code: '123456' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await start({ email: 'other@example.com' });
    await finishing;

    expect(JSON.parse(await fs.readFile(pendingFile(), 'utf-8'))).toMatchObject({
      requestId: 'request-2',
      email: 'other@example.com',
    });
  });

  it('reuses its client on the next sign-in instead of registering again', async () => {
    api({
      '/register': registered,
      '/v2/oauth/email-code': started,
      '/v2/oauth/email-code/token': tokens('first'),
    });
    await start();
    await finishEmailLogin({ baseUrl: API, code: '123456' });
    await start();

    expect(calls.filter((sent) => sent.url === REGISTER)).toHaveLength(1);
  });

  it('registers again when the API no longer knows the saved client', async () => {
    await expiredLogin();
    let asked = 0;
    api({
      '/register': { body: { client_id: 'client-2' } },
      '/v2/oauth/email-code': () =>
        asked++ === 0 ? { status: 401, body: { error: 'invalid_client' } } : started,
    });

    await start();

    expect(calls.map((sent) => sent.body.client_id ?? 'register')).toEqual([
      'client-1',
      'register',
      'client-2',
    ]);
  });

  it('keeps the request after a wrong code, so the person can try again', async () => {
    api({
      '/register': registered,
      '/v2/oauth/email-code': started,
      '/v2/oauth/email-code/token': {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Incorrect code.' },
      },
    });
    await start();

    // The next command names this API, so it does not reach production instead.
    await expect(finishEmailLogin({ baseUrl: API, code: '000000' })).rejects.toThrow(
      `That code is not right. Check the email and run: ${packageCommand(API, 'login --code <code>')}`,
    );
    expect(await exists(pendingFile())).toBe(true);
    expect(await loadCredentials()).toBeNull();
  });

  it.each([
    [
      { status: 400, body: { error: 'invalid_grant', error_description: 'Code expired.' } },
      'expired or was already used',
    ],
    [{ status: 429, retryAfter: '900', body: {} }, 'Too many incorrect codes'],
    [{ status: 403, body: { errorCode: 'web_approval_required' } }, 'approve the connection'],
    [
      { status: 403, body: { error: 'access_denied', error_description: 'Not this email.' } },
      'Not this email.',
    ],
  ])('ends the request when finishing is refused with %j', async (reply, message) => {
    api({
      '/register': registered,
      '/v2/oauth/email-code': started,
      '/v2/oauth/email-code/token': reply,
    });
    await start();

    await expect(finishEmailLogin({ baseUrl: API, code: '123456' })).rejects.toThrow(message);
    expect(await exists(pendingFile())).toBe(false);
  });

  it.each([
    [
      { status: 403, body: { errorCode: 'email_code_connect_unavailable' } },
      'not available yet. Sign in through the browser instead',
    ],
    [{ status: 429, retryAfter: '120', body: {} }, 'Try again in 2 minutes'],
  ])('explains a refused start: %j', async (reply, message) => {
    api({ '/register': registered, '/v2/oauth/email-code': reply });

    await expect(start()).rejects.toThrow(message);
    expect(await exists(pendingFile())).toBe(false);
  });

  it('says there is nothing to finish without a started sign-in', async () => {
    await expect(finishEmailLogin({ baseUrl: API, code: '123456' })).rejects.toThrow(
      'No sign-in is waiting',
    );
  });

  it('asks where to register for an API other than production', async () => {
    api({});

    await expect(start({ registrationUrl: undefined })).rejects.toThrow(
      'SYNC_MCP_REGISTRATION_URL',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('the commands it prints', () => {
  it('name the API only when it is not production', () => {
    expect(packageCommand('https://api.sync.so/', 'login --code <code>')).toBe(
      'npx -y @sync.so/mcp-server@latest login --code <code>',
    );
    expect(packageCommand('https://dev-api.sync.so')).toBe(
      'npx -y @sync.so/mcp-server@latest --base-url https://dev-api.sync.so',
    );
  });
});

describe('the saved sign-in', () => {
  it('still reads a device-flow file, and never hands out a refreshable token as one', async () => {
    await saveToken('device-token', new Date(Date.now() + 60_000).toISOString());
    expect(await loadToken()).toBe('device-token');
    expect(await savedEmailLogin(API)).toBeNull();

    await expiredLogin();
    expect(await loadToken()).toBeNull();
  });

  it('belongs to the API it was made for', async () => {
    await expiredLogin('https://other.test');

    expect(await savedEmailLogin(API)).toBeNull();
    await expect(auth()).rejects.toThrow('Sign in again');
  });

  it('uses the saved token while it is fresh', async () => {
    api({});
    await saveCredentials({
      token: 'oat-fresh',
      refreshToken: 'refresh-fresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: 'client-1',
      email: EMAIL,
      baseUrl: API,
    });

    await expect(auth()).resolves.toEqual({ Authorization: 'Bearer oat-fresh' });
    expect(calls).toHaveLength(0);
  });

  it('renews an expiring token and saves the rotated pair', async () => {
    await expiredLogin();
    api({ '/v2/oauth/token': tokens('new') });

    await expect(auth()).resolves.toEqual({ Authorization: 'Bearer oat-new' });

    expect(call(0).body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
      client_id: 'client-1',
    });
    expect(await loadCredentials()).toMatchObject({
      token: 'oat-new',
      refreshToken: 'refresh-new',
      clientId: 'client-1',
      baseUrl: API,
    });
  });

  it('lets two servers sharing the file renew once between them', async () => {
    await expiredLogin();
    api({
      '/v2/oauth/token': async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return tokens('new');
      },
    });

    // Each server process holds its own source; only the file and its lock are shared.
    const headers = await Promise.all([auth(), auth()]);

    expect(headers).toEqual([
      { Authorization: 'Bearer oat-new' },
      { Authorization: 'Bearer oat-new' },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('is not overwritten by a renewal another server had in flight', async () => {
    await expiredLogin();
    api({
      '/v2/oauth/token': async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return tokens('renewed-old-account');
      },
      '/register': registered,
      '/v2/oauth/email-code': started,
      '/v2/oauth/email-code/token': tokens('new-login'),
    });
    await start({ email: 'other@example.com' });

    const renewal = auth();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await finishEmailLogin({ baseUrl: API, code: '123456' });
    await renewal;

    expect(await loadCredentials()).toMatchObject({
      token: 'oat-new-login',
      email: 'other@example.com',
    });
  });

  it('asks for a restart once the file holds another account, and carries on for the same one', async () => {
    await expiredLogin();
    await saveCredentials({ ...(await loadCredentials()), token: 'oat-b', email: 'other@x.co' });
    api({});
    await expect(auth()).rejects.toThrow('Restart the sync. server');
    expect(calls).toHaveLength(0);

    await saveCredentials({
      ...(await loadCredentials()),
      token: 'oat-again',
      email: EMAIL,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await expect(auth()).resolves.toEqual({ Authorization: 'Bearer oat-again' });
  });

  it('says to sign in again once the connection is gone, and keeps trying through an outage', async () => {
    await expiredLogin();
    api({ '/v2/oauth/token': { status: 503 } });
    await expect(auth()).rejects.toThrow('could not renew the sign-in (503)');

    api({ '/v2/oauth/token': { status: 400, body: { error: 'invalid_grant' } } });
    await expect(auth()).rejects.toThrow('login --email');
  });
});
