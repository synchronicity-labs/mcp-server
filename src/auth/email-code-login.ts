import { createHash, randomBytes } from 'node:crypto';
import { PACKAGE_VERSION } from '../version.js';
import {
  loadCredentials,
  readStoreFile,
  removeStoreFile,
  type StoredCredentials,
  saveCredentials,
  withStoreLock,
  writeStoreFile,
} from './token-store.js';

/**
 * Signs a person in by a code emailed to them, with no browser: `start` emails the
 * code, `finish` exchanges it, and `emailLoginAuth` keeps the saved sign-in fresh.
 * The API connects only the person's personal workspace this way.
 */

const DEFAULT_API_URL = 'https://api.sync.so';
/** The hosted server's open registration, which every MCP client already uses. */
const HOSTED_REGISTRATION_URL = 'https://mcp.sync.so/register';
// Registration requires a callback. This client never opens a browser, so nothing listens.
const UNUSED_REDIRECT_URI = 'http://127.0.0.1/callback';
const PENDING_FILE = 'mcp-login.json';
const REQUEST_TIMEOUT_MS = 20_000;
// Refresh a little early, so a request never leaves with a token about to expire.
const REFRESH_MARGIN_MS = 60_000;

const DEFAULT_AGENT_NAME = 'sync. MCP server';
const PACKAGE_COMMAND = 'npx -y @sync.so/mcp-server@latest';
const BROWSER_SIGN_IN =
  'Sign in through the browser instead: add the hosted server (https://mcp.sync.so/mcp) to your agent, or start this server without an API key and open the link it prints.';

/** A refusal whose message is written for the person signing in. */
export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

type PendingLogin = {
  requestId: string;
  codeVerifier: string;
  clientId: string;
  clientName: string;
  baseUrl: string;
  email: string;
  expiresAt: string;
};

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number };
type Refusal = { status: number; code?: string; description?: string; retryAfterSeconds?: number };

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

const sameApi = (left: string | undefined, right: string) =>
  left !== undefined && withSlash(left) === withSlash(right);

/** A path on the API, whether or not its base URL ends with a slash. */
export const apiUrl = (baseUrl: string, path: string) => `${withSlash(baseUrl)}${path}`;

/**
 * This package's command line for the API in use, so a printed next step reaches the
 * API the sign-in was made for and not production.
 */
export function packageCommand(baseUrl: string, args = ''): string {
  const target = sameApi(DEFAULT_API_URL, baseUrl) ? '' : ` --base-url ${baseUrl}`;
  return `${PACKAGE_COMMAND}${args ? ` ${args}` : ''}${target}`;
}

const startAgain = (baseUrl: string) =>
  `Start again with: ${packageCommand(baseUrl, 'login --email <your email>')}`;

function field(body: unknown, name: string): string | undefined {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : null;
  return typeof value === 'string' ? value : undefined;
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ ok: true; body: unknown } | Refusal> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-mcp-version': PACKAGE_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new LoginError(
      `Could not reach ${new URL(url).host}. Check the connection and try again.`,
    );
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (response.ok) return { ok: true, body: parsed };
  const retryAfter = Number(response.headers.get('Retry-After'));
  return {
    status: response.status,
    code: field(parsed, 'errorCode') ?? field(parsed, 'error'),
    description: field(parsed, 'error_description') ?? field(parsed, 'message'),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
  };
}

function waitFor(seconds: number | undefined): string {
  if (!seconds) return 'later';
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'in a minute' : `in ${minutes} minutes`;
}

/** What to tell the person for a refusal both steps share. */
function sharedRefusal(refusal: Refusal): LoginError {
  if (refusal.status === 429) {
    return new LoginError(`Too many attempts. Try again ${waitFor(refusal.retryAfterSeconds)}.`);
  }
  if (refusal.code === 'email_code_connect_unavailable') {
    return new LoginError(`Signing in by emailed code is not available yet. ${BROWSER_SIGN_IN}`);
  }
  if (refusal.code === 'web_approval_required') {
    return new LoginError(
      `This account has to approve the connection on the web, because a code connects only a personal workspace. ${BROWSER_SIGN_IN}`,
    );
  }
  if (refusal.code === 'access_denied') {
    return new LoginError(refusal.description ?? 'This email cannot connect to sync.');
  }
  return new LoginError(
    `sync. refused the sign-in (${refusal.status}${refusal.description ? `: ${refusal.description}` : ''}).`,
  );
}

async function registerClient(registrationUrl: string, clientName: string): Promise<string> {
  const result = await postJson(registrationUrl, {
    client_name: clientName,
    redirect_uris: [UNUSED_REDIRECT_URI],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  const clientId = 'ok' in result ? field(result.body, 'client_id') : undefined;
  // A client given a secret could not finish: this server keeps none.
  if (!clientId || ('ok' in result && field(result.body, 'client_secret'))) {
    throw new LoginError(`Could not register this server with sync. ${BROWSER_SIGN_IN}`);
  }
  return clientId;
}

/** Where to register a client for this API; a client is valid only where it was registered. */
function registrationUrlFor(baseUrl: string, override: string | undefined): string {
  if (override) return override;
  if (sameApi(DEFAULT_API_URL, baseUrl)) return HOSTED_REGISTRATION_URL;
  throw new LoginError(
    `Signing in to ${baseUrl} needs SYNC_MCP_REGISTRATION_URL, the /register URL of an MCP server that uses that API.`,
  );
}

/** The client an earlier sign-in registered for this API under this name, if any. */
async function knownClient(baseUrl: string, clientName: string): Promise<string | undefined> {
  const candidates = [
    await readStoreFile<PendingLogin>(PENDING_FILE),
    await loadCredentials(),
  ] as const;
  return candidates.find(
    (saved) =>
      saved?.clientId && saved.clientName === clientName && sameApi(saved.baseUrl, baseUrl),
  )?.clientId;
}

/** Emails the person a code and keeps what `finishEmailLogin` needs to exchange it. */
export async function startEmailLogin(params: {
  baseUrl: string;
  email: string;
  agentName?: string;
  registrationUrl?: string;
}): Promise<{ email: string; expiresInMinutes: number }> {
  const { baseUrl, email } = params;
  const clientName = params.agentName?.trim() || DEFAULT_AGENT_NAME;
  const codeVerifier = randomBytes(32).toString('base64url');
  const known = await knownClient(baseUrl, clientName);
  // A saved client the API no longer knows is replaced once.
  for (const reuse of known ? [known, undefined] : [undefined]) {
    const clientId =
      reuse ??
      (await registerClient(registrationUrlFor(baseUrl, params.registrationUrl), clientName));
    const result = await postJson(apiUrl(baseUrl, 'v2/oauth/email-code'), {
      client_id: clientId,
      email,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    if (!('ok' in result)) {
      if (reuse && (result.code === 'invalid_client' || result.code === 'unauthorized_client')) {
        continue;
      }
      throw sharedRefusal(result);
    }
    const requestId = field(result.body, 'request_id');
    const expiresIn = Number((result.body as { expires_in?: unknown } | null)?.expires_in) || 600;
    if (!requestId) throw new LoginError('sync. did not start the sign-in. Try again.');
    const pending: PendingLogin = {
      requestId,
      codeVerifier,
      clientId,
      clientName,
      baseUrl,
      email,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
    await withStoreLock(() => writeStoreFile(PENDING_FILE, pending));
    return { email, expiresInMinutes: Math.round(expiresIn / 60) };
  }
  throw new LoginError('sync. did not start the sign-in. Try again.');
}

/**
 * Forgets a finished request, unless a newer sign-in has replaced it meanwhile: that
 * one's code is still on its way to the person.
 */
function forget(finished: PendingLogin): Promise<void> {
  return withStoreLock(async () => {
    const current = await readStoreFile<PendingLogin>(PENDING_FILE);
    if (current?.requestId === finished.requestId) await removeStoreFile(PENDING_FILE);
  });
}

/** Exchanges the emailed code for the saved sign-in. A wrong code can be tried again. */
export async function finishEmailLogin(params: {
  baseUrl: string;
  code: string;
}): Promise<{ email: string }> {
  const START_AGAIN = startAgain(params.baseUrl);
  const pending = await readStoreFile<PendingLogin>(PENDING_FILE);
  if (!pending?.requestId || !sameApi(pending.baseUrl, params.baseUrl)) {
    throw new LoginError(`No sign-in is waiting for a code. ${START_AGAIN}`);
  }
  if (new Date(pending.expiresAt) <= new Date()) {
    await forget(pending);
    throw new LoginError(`That code has expired. ${START_AGAIN}`);
  }
  const result = await postJson(apiUrl(pending.baseUrl, 'v2/oauth/email-code/token'), {
    client_id: pending.clientId,
    request_id: pending.requestId,
    code: params.code.trim(),
    code_verifier: pending.codeVerifier,
  });
  if (!('ok' in result)) {
    if (result.code === 'invalid_grant' && result.description === 'Incorrect code.') {
      throw new LoginError(
        `That code is not right. Check the email and run: ${packageCommand(params.baseUrl, 'login --code <code>')}`,
      );
    }
    // Every other refusal ends the request, so the next step is a new code.
    await forget(pending);
    if (result.code === 'invalid_grant') {
      throw new LoginError(`That code expired or was already used. ${START_AGAIN}`);
    }
    if (result.status === 429) {
      throw new LoginError(
        `Too many incorrect codes. ${START_AGAIN} ${waitFor(result.retryAfterSeconds)}.`,
      );
    }
    throw sharedRefusal(result);
  }
  const login = issued(result.body, pending);
  await forget(pending);
  if (!login) throw new LoginError(`sync. did not finish the sign-in. ${START_AGAIN}`);
  // Under the lock, so a renewal another server has in flight cannot save over it.
  await withStoreLock(() => saveCredentials(login));
  return { email: pending.email };
}

/** The sign-in to save from a token response, or null when the response is not one. */
function issued(
  body: unknown,
  login: Pick<StoredCredentials, 'clientId' | 'clientName' | 'baseUrl' | 'email'>,
): StoredCredentials | null {
  const tokens = body as Partial<TokenResponse> | null;
  if (!tokens?.access_token || !tokens.refresh_token || !tokens.expires_in) return null;
  return {
    token: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    clientId: login.clientId,
    clientName: login.clientName,
    email: login.email,
    baseUrl: login.baseUrl,
  };
}

type EmailLogin = StoredCredentials & { refreshToken: string; clientId: string; baseUrl: string };

/** The saved emailed-code sign-in for this API, or null when there is none. */
export async function savedEmailLogin(baseUrl: string): Promise<EmailLogin | null> {
  const saved = await loadCredentials();
  return saved?.refreshToken && saved.clientId && sameApi(saved.baseUrl, baseUrl)
    ? (saved as EmailLogin)
    : null;
}

const fresh = (login: EmailLogin) =>
  !!login.expiresAt && new Date(login.expiresAt).getTime() - Date.now() > REFRESH_MARGIN_MS;

const signedOut = (baseUrl: string) =>
  `The sync. sign-in was disconnected or has expired. Sign in again with: ${packageCommand(baseUrl, 'login --email <your email>')}`;

// A running server keeps the account's tools and workspace, which a renewed token must match.
const ACCOUNT_CHANGED =
  'The sync. sign-in now belongs to another account. Restart the sync. server (start a new agent session) to use it.';

async function refresh(login: EmailLogin): Promise<EmailLogin> {
  let result: Awaited<ReturnType<typeof postJson>>;
  try {
    result = await postJson(apiUrl(login.baseUrl, 'v2/oauth/token'), {
      grant_type: 'refresh_token',
      refresh_token: login.refreshToken,
      client_id: login.clientId,
    });
  } catch {
    throw new Error('Could not reach sync. to renew the sign-in. Try again.');
  }
  const renewed = 'ok' in result ? issued(result.body, login) : null;
  if (renewed) {
    await saveCredentials(renewed);
    return renewed as EmailLogin;
  }
  if ('ok' in result) throw new Error('sync. could not renew the sign-in. Try again shortly.');
  // Only the API saying the grant is gone ends the sign-in; an outage does not.
  if (result.status >= 500 || result.status === 429) {
    throw new Error(`sync. could not renew the sign-in (${result.status}). Try again shortly.`);
  }
  throw new Error(signedOut(login.baseUrl));
}

/** The saved sign-in, while it is still the account this server started with. */
async function sameLogin(baseUrl: string, email: string | undefined): Promise<EmailLogin> {
  const saved = await savedEmailLogin(baseUrl);
  if (!saved) throw new Error(signedOut(baseUrl));
  if (saved.email !== email) throw new Error(ACCOUNT_CHANGED);
  return saved;
}

async function currentHeaders(
  baseUrl: string,
  email: string | undefined,
): Promise<Record<string, string>> {
  const bearer = (login: EmailLogin) => ({ Authorization: `Bearer ${login.token}` });
  // Read every time: another server sharing the file may have renewed the tokens.
  const saved = await sameLogin(baseUrl, email);
  if (fresh(saved)) return bearer(saved);
  return withStoreLock(async () => {
    const latest = await sameLogin(baseUrl, email);
    return bearer(fresh(latest) ? latest : await refresh(latest));
  });
}

/**
 * Auth headers for each API request from the saved sign-in, renewed before it expires,
 * with what to tell the person once sync. no longer accepts it. It stays with the
 * account it started as: signing in again as the same person carries on, and signing
 * in as someone else asks for a restart.
 */
export function emailLoginAuth(
  login: Pick<EmailLogin, 'baseUrl' | 'email'>,
): (() => Promise<Record<string, string>>) & { signedOutStep: string } {
  let pending: Promise<Record<string, string>> | undefined;
  const headers = () => {
    pending ??= currentHeaders(login.baseUrl, login.email).finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return Object.assign(headers, { signedOutStep: signedOut(login.baseUrl) });
}
