#!/usr/bin/env node
import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';

// Unauthenticated post-deploy smoke check. It waits until /health reports the
// deployed revision from a process started after the deploy began, so an old pod
// that keeps serving (or restarts) while the new one crash-loops does not pass.
// Then it checks the exact OAuth discovery URLs clients use and that /mcp
// challenges a request without a token with the right resource metadata.
//
// Each request is retried with backoff until one overall deadline, and a failure
// names what the attempts saw (DNS, refused, reset, TLS, HTTP status or the wrong
// revision), so a runner that cannot reach the server reads differently from a
// deploy that never came up.

const REQUEST_TIMEOUT_MS = 10_000;

/** One attempt that may succeed if tried again: no response, an HTTP error, or a server not ready yet. */
class AttemptError extends Error {
  constructor(message, { responded }) {
    super(message);
    this.responded = responded;
  }
}

/** A step ran out of time. `responded` says whether any attempt got an HTTP response. */
class StepTimeoutError extends Error {
  constructor(message, { responded }) {
    super(message);
    this.responded = responded;
  }
}

/** The error that says why: undici wraps it as a cause, sometimes nested or as one error per address. */
function codedCause(error) {
  let cause = error.cause;
  for (let depth = 0; cause && typeof cause === 'object' && depth < 4; depth++) {
    if (cause.code) return cause;
    const inner = cause.errors?.find((each) => each?.code);
    if (inner) return inner;
    if (!cause.cause) break;
    cause = cause.cause;
  }
  return error.cause;
}

function causeMessage(cause) {
  if (cause.message) return cause.message;
  return (cause.errors ?? [])
    .map((each) => each?.message)
    .filter(Boolean)
    .join(', ');
}

/**
 * Why a fetch threw, e.g. `ECONNREFUSED: connect ECONNREFUSED 203.0.113.7:443` rather
 * than undici's bare "fetch failed".
 */
export function describeFetchError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = codedCause(error);
  if (cause === undefined || cause === null) {
    return error.name === 'Error' ? error.message : `${error.name}: ${error.message}`;
  }
  if (typeof cause !== 'object') return `${error.message}: ${String(cause)}`;
  const code = cause.code ?? cause.name ?? 'Error';
  const message = causeMessage(cause);
  return message && message !== code ? `${code}: ${message}` : code;
}

const clock = (ms) => new Date(ms).toISOString().slice(11, 19);

/** Distinct attempt errors with how often and when each was seen. */
export class AttemptLog {
  #errors = new Map();
  attempts = 0;
  responded = false;

  record(error, at, { responded }) {
    this.attempts++;
    this.responded ||= responded;
    const seen = this.#errors.get(error);
    // Reinsert so the map stays ordered by when each error was last seen.
    this.#errors.delete(error);
    this.#errors.set(
      error,
      seen ? { ...seen, count: seen.count + 1, last: at } : { count: 1, first: at, last: at },
    );
  }

  /** The most recent `limit` distinct errors, oldest first: `ECONNREFUSED ×58 (12:08:14–12:18:15)`. */
  summary(limit = 3) {
    const entries = [...this.#errors];
    const shown = entries.slice(-limit).map(([error, { count, first, last }]) => {
      const when = first === last ? clock(first) : `${clock(first)}–${clock(last)}`;
      return `${error} ×${count} (${when})`;
    });
    const hidden = entries.length - shown.length;
    if (hidden > 0) shown.unshift(`${hidden} earlier distinct error${hidden === 1 ? '' : 's'}`);
    return shown.join('; ');
  }
}

/** Delay before retry number `retry` (1-based): initialMs, doubling, capped at maxMs. */
export function backoffDelay(retry, { initialMs, maxMs }) {
  return Math.min(maxMs, initialMs * 2 ** (retry - 1));
}

/**
 * Runs `attempt` until it returns, retrying AttemptErrors with backoff until `deadline`.
 * A step that starts at or past the deadline still gets `minAttempts` tries. Any other
 * error (a wrong document, say) fails at once: trying again would not change it.
 */
async function retryStep(
  name,
  attempt,
  {
    deadline,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    initialDelayMs = 1_000,
    maxDelayMs = 10_000,
    minAttempts = 1,
    timeoutMessage = () => `${name} did not succeed in time`,
    notice = () => {},
  },
) {
  const log = new AttemptLog();
  for (let tries = 1; ; tries++) {
    try {
      const result = await attempt();
      if (tries > 1) notice(`${name} succeeded on attempt ${tries} (earlier: ${log.summary()})`);
      return result;
    } catch (error) {
      if (!(error instanceof AttemptError)) throw error;
      log.record(error.message, now(), error);
    }
    const remaining = deadline - now();
    if (remaining <= 0 && tries >= minAttempts) {
      throw new StepTimeoutError(
        `${timeoutMessage()} (${log.attempts} attempts; last ${name} errors: ${log.summary()})`,
        log,
      );
    }
    const delay = backoffDelay(tries, { initialMs: initialDelayMs, maxMs: maxDelayMs });
    await sleep(tries < minAttempts ? delay : Math.min(delay, remaining));
  }
}

async function request(fetchImpl, url, init = {}) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new AttemptError(describeFetchError(error), { responded: false });
  }
}

function httpError(res) {
  return new AttemptError(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`, {
    responded: true,
  });
}

async function getJson(fetchImpl, url) {
  const res = await request(fetchImpl, url);
  if (!res.ok) {
    await res.body?.cancel();
    throw httpError(res);
  }
  try {
    return await res.json();
  } catch (error) {
    throw new AttemptError(`unreadable body: ${describeFetchError(error)}`, { responded: true });
  }
}

function expectEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Why this /health answer does not pass yet, or undefined when it does. */
function healthProblem(health, { deployStartedAt, expectedRevision }) {
  if (health?.status !== 'ok') return `status ${JSON.stringify(health?.status)}`;
  const revision = JSON.stringify(health.revision);
  if (expectedRevision && health.revision !== expectedRevision) {
    return `revision ${revision} serving, started ${health.startedAt}`;
  }
  const started = Date.parse(health.startedAt);
  if (Number.isNaN(started))
    return `revision ${revision} with startedAt ${JSON.stringify(health.startedAt)}`;
  if (started < deployStartedAt)
    return `revision ${revision} started ${health.startedAt}, before the deploy`;
  return undefined;
}

export async function waitForNewProcess({
  baseUrl,
  deployStartedAt,
  expectedRevision,
  timeoutMs,
  intervalMs,
  initialDelayMs = 1_000,
  fetchImpl = fetch,
  now = Date.now,
  sleep,
  notice,
}) {
  const url = new URL('/health', baseUrl);
  return retryStep(
    '/health',
    async () => {
      const health = await getJson(fetchImpl, url);
      const problem = healthProblem(health, { deployStartedAt, expectedRevision });
      if (problem) throw new AttemptError(problem, { responded: true });
      return health;
    },
    {
      deadline: now() + timeoutMs,
      now,
      sleep,
      initialDelayMs: Math.min(initialDelayMs, intervalMs),
      maxDelayMs: intervalMs,
      notice,
      timeoutMessage: () =>
        `No ${expectedRevision ? `revision ${expectedRevision} ` : ''}server process started after ${new Date(deployStartedAt).toISOString()} within ${timeoutMs / 1000}s`,
    },
  );
}

/**
 * Checks discovery and the /mcp challenge. Network errors and HTTP errors are retried
 * until `deadline` (each step gets at least three tries); a wrong answer fails at once.
 */
export async function checkPublicSurface({
  baseUrl,
  fetchImpl = fetch,
  deadline,
  now = Date.now,
  sleep,
  initialDelayMs = 1_000,
  maxDelayMs = 10_000,
  notice,
}) {
  const retry = {
    deadline: deadline ?? now(),
    now,
    sleep,
    initialDelayMs,
    maxDelayMs,
    minAttempts: 3,
    notice,
  };
  const origin = new URL(baseUrl);
  const issuer = new URL('/', origin).href;
  const resourceUrl = new URL('/.well-known/oauth-protected-resource/mcp', origin);
  const resource = await retryStep(
    `GET ${resourceUrl.pathname}`,
    () => getJson(fetchImpl, resourceUrl),
    retry,
  );
  expectEqual(resource.resource, new URL('/mcp', origin).href, 'protected resource');
  expectEqual(resource.authorization_servers?.[0], issuer, 'authorization server');
  const serverUrl = new URL('/.well-known/oauth-authorization-server', origin);
  const server = await retryStep(
    `GET ${serverUrl.pathname}`,
    () => getJson(fetchImpl, serverUrl),
    retry,
  );
  expectEqual(server.issuer, issuer, 'issuer');
  for (const [endpoint, path] of [
    ['authorization_endpoint', '/authorize'],
    ['token_endpoint', '/token'],
    ['registration_endpoint', '/register'],
  ]) {
    expectEqual(server[endpoint], new URL(path, origin).href, endpoint);
  }
  const res = await retryStep('POST /mcp', () => challenge(fetchImpl, origin), retry);
  expectEqual(res.status, 401, 'unauthenticated /mcp status');
  expectEqual(
    /resource_metadata="([^"]*)"/.exec(res.challenge)?.[1],
    resourceUrl.href,
    'unauthenticated /mcp resource_metadata',
  );
}

async function challenge(fetchImpl, origin) {
  const res = await request(fetchImpl, new URL('/mcp', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  await res.body?.cancel();
  if (res.status >= 500 || res.status === 429) throw httpError(res);
  return { status: res.status, challenge: res.headers.get('www-authenticate') ?? '' };
}

/** What the runner's resolver returns for `hostname`, for a failure that never got a response. */
export async function connectivityDiagnostic(
  hostname,
  { lookupImpl = lookup, timeoutMs = 10_000 } = {},
) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs);
  });
  try {
    const addresses = await Promise.race([lookupImpl(hostname, { all: true }), timeout]);
    const list = addresses.map(({ address, family }) => `${address} (IPv${family})`).join(', ');
    return `DNS lookup ${hostname}: ${list || 'no addresses'}`;
  } catch (error) {
    return `DNS lookup ${hostname} failed: ${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The earliest start time a passing process may report. A run that deployed waits for a
 * process started after its deploy began; a run that found its revision already live
 * (allowExisting) checks the process that is serving.
 */
export function deployStartFrom({ deployStartedAt, allowExisting }) {
  if (allowExisting) return 0;
  const parsed = Date.parse(deployStartedAt ?? '');
  if (Number.isNaN(parsed)) throw new Error('DEPLOY_STARTED_AT must be an ISO timestamp.');
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseUrl = process.env.SMOKE_BASE_URL ?? 'https://mcp.sync.so';
  const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 600_000);
  const deadline = Date.now() + timeoutMs;
  const notice = (message) => console.log(message);
  try {
    const deployStartedAt = deployStartFrom({
      deployStartedAt: process.env.DEPLOY_STARTED_AT,
      allowExisting: process.env.SMOKE_ALLOW_EXISTING_PROCESS === 'true',
    });
    const health = await waitForNewProcess({
      baseUrl,
      deployStartedAt,
      expectedRevision: process.env.EXPECTED_REVISION || undefined,
      timeoutMs,
      intervalMs: 10_000,
      notice,
    });
    await checkPublicSurface({ baseUrl, deadline, notice });
    console.log(
      `Deploy smoke check passed: revision ${health.revision} started ${health.startedAt}.`,
    );
  } catch (error) {
    console.error(`Deploy smoke check failed: ${error instanceof Error ? error.message : error}`);
    if (error instanceof StepTimeoutError && !error.responded) {
      console.error(
        `No attempt got an HTTP response. ${await connectivityDiagnostic(new URL(baseUrl).hostname)}`,
      );
    }
    process.exit(1);
  }
}
