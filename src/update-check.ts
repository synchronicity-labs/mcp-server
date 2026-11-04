import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Local (stdio) installs go stale silently: npx keeps running whatever it cached. At
 * startup the CLI asks the npm registry for the latest version, at most once a day, and
 * the server tells the agent when this copy is older. The hosted server deploys on every
 * merge, so it never checks. Any failure means no notice.
 */
export const UPDATE_CHECK_TIMEOUT_MS = 2_000;
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const LATEST_URL = 'https://registry.npmjs.org/@sync.so/mcp-server/latest';
const CACHE_FILE = path.join(os.homedir(), '.config', 'sync', 'mcp-update-check.json');

const HOSTED_MCP_URL = 'https://mcp.sync.so/mcp';
const UPDATE_COMMAND = 'npx -y @sync.so/mcp-server@latest';

export type AvailableUpdate = { current: string; latest: string };

export type UpdateCheck = {
  /** The newer version once the check has found one; never waits for it. */
  available: () => AvailableUpdate | undefined;
  /** Settles when the check finishes. Never rejects. */
  done: Promise<void>;
};

type CacheEntry = { checkedAt: string; latest?: string };

/** SYNC_MCP_UPDATE_CHECK accepts off/false/0/no and on/true/1/yes (default). */
export function parseUpdateCheck(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['off', 'false', '0', 'no'].includes(normalized)) return false;
  if (['on', 'true', '1', 'yes'].includes(normalized)) return true;
  throw new Error(`SYNC_MCP_UPDATE_CHECK must be on or off, not "${value}"`);
}

/** CI runs are unattended and often offline; CI=false or CI=0 still checks. */
function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CI?.trim().toLowerCase();
  return Boolean(value) && value !== 'false' && value !== '0';
}

const SEMVER =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver precedence: negative when a < b, positive when a > b, undefined when unparsable. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = SEMVER.exec(a.trim());
  const right = SEMVER.exec(b.trim());
  if (!left || !right) return undefined;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  return comparePrerelease(left[4], right[4]);
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  // A release outranks any of its prereleases.
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  const left = a.split('.');
  const right = b.split('.');
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index];
    const y = right[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function updateInstruction({ current, latest }: AvailableUpdate): string {
  return `This sync. MCP server is version ${current}; version ${latest} is available. Tell the user to update: restart with \`${UPDATE_COMMAND}\` (or reinstall), or switch to the hosted server at ${HOSTED_MCP_URL}, which is always current.`;
}

export function updateToolNotice({ current, latest }: AvailableUpdate): string {
  return `Update available: this sync. MCP server is ${current} and ${latest} is out. Tell the user to restart it with \`${UPDATE_COMMAND}\`, or to use the hosted server at ${HOSTED_MCP_URL}.`;
}

/** The CLI's gate: local (stdio) installs only, unless opted out or running in CI. */
export function startConfiguredUpdateCheck(
  config: { transport: 'stdio' | 'http'; updateCheck?: boolean },
  currentVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<Parameters<typeof startUpdateCheck>[0], 'currentVersion'> = {},
): UpdateCheck | undefined {
  if (config.transport !== 'stdio' || config.updateCheck === false || isCi(env)) return undefined;
  return startUpdateCheck({ ...options, currentVersion });
}

/** Starts the check in the background and returns at once. */
export function startUpdateCheck(options: {
  currentVersion: string;
  cacheFile?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): UpdateCheck {
  let available: AvailableUpdate | undefined;
  const current = options.currentVersion;
  const done = findLatest(options)
    .then((latest) => {
      if (latest && (compareVersions(latest, current) ?? 0) > 0) available = { current, latest };
    })
    .catch(() => undefined);
  return { done, available: () => available };
}

async function findLatest(options: {
  cacheFile?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const cacheFile = options.cacheFile ?? CACHE_FILE;
  const now = options.now?.() ?? Date.now();
  const cached = await readCache(cacheFile);
  const age = cached ? now - Date.parse(cached.checkedAt) : Number.NaN;
  if (cached && age >= 0 && age < UPDATE_CHECK_TTL_MS) return cached.latest;

  const latest = await fetchLatest(options.fetch ?? fetch, options.timeoutMs);
  // Failures are cached too, so an offline machine still asks at most once a day.
  await writeCache(cacheFile, {
    checkedAt: new Date(now).toISOString(),
    ...(latest ? { latest } : {}),
  });
  return latest;
}

async function fetchLatest(
  fetchImpl: typeof fetch,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(LATEST_URL, {
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const version =
      body && typeof body === 'object' && 'version' in body ? body.version : undefined;
    return typeof version === 'string' && SEMVER.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

async function readCache(file: string): Promise<CacheEntry | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return undefined;
    const { checkedAt, latest } = parsed as Record<string, unknown>;
    if (typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt))) return undefined;
    return {
      checkedAt,
      ...(typeof latest === 'string' && SEMVER.test(latest) ? { latest } : {}),
    };
  } catch {
    return undefined;
  }
}

async function writeCache(file: string, entry: CacheEntry): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // A read-only home only means checking again next start.
  }
}
