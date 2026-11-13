import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The one saved sign-in for the local server. The device flow saves a token and
 * its expiry; an emailed-code sign-in also saves what refreshing it needs.
 */
export type StoredCredentials = {
  token: string;
  expiresAt?: string;
  refreshToken?: string;
  /** The OAuth client the refresh token belongs to, and the name it registered. */
  clientId?: string;
  clientName?: string;
  /** The account's email, so a running server notices a sign-in as someone else. */
  email?: string;
  /** The API these tokens are for, so they are never sent to another one. */
  baseUrl?: string;
};

// The holder does one bounded request, so a lock older than this was left by a crash.
const LOCK_STALE_MS = 30_000;
// Longer than that request may take, so a waiter outlasts a slow holder.
const LOCK_WAIT_MS = 25_000;
const LOCK_RETRY_MS = 100;

/** Resolved per call, so the files follow the home directory in effect. */
export function storePath(file: string): string {
  return path.join(os.homedir(), '.config', 'sync', file);
}

const credentialsFile = () => storePath('mcp-credentials.json');

export async function readStoreFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(storePath(file), 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Replaces the file in one step, so a reader never sees half of it. */
export async function writeStoreFile(file: string, value: unknown): Promise<void> {
  const target = storePath(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  await fs.rename(temporary, target);
}

export async function removeStoreFile(file: string): Promise<void> {
  await fs.rm(storePath(file), { force: true });
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
  const credentials = await readStoreFile<StoredCredentials>('mcp-credentials.json');
  return typeof credentials?.token === 'string' ? credentials : null;
}

export async function saveCredentials(credentials: StoredCredentials): Promise<void> {
  await writeStoreFile('mcp-credentials.json', credentials);
}

/** A device-flow token that has not expired. A refreshable sign-in is read whole instead. */
export async function loadToken(): Promise<string | null> {
  const credentials = await loadCredentials();
  if (!credentials || credentials.refreshToken) return null;
  if (credentials.expiresAt && new Date(credentials.expiresAt) < new Date()) return null;
  return credentials.token;
}

export async function saveToken(token: string, expiresAt?: string): Promise<void> {
  await saveCredentials({ token, expiresAt });
}

export async function clearToken(): Promise<void> {
  await fs.rm(credentialsFile(), { force: true });
}

const quietly = (work: Promise<unknown>) => work.catch(() => undefined);

/**
 * Clears what a crashed holder left, without ever touching a live lock. A stale
 * holder's file is removed by its own name, which no later holder shares, and a
 * directory is removed only while empty, which a held lock never is.
 */
async function clearAbandoned(lock: string): Promise<boolean> {
  const [holder] = await fs.readdir(lock).catch(() => []);
  if (!holder) {
    await quietly(fs.rmdir(lock));
    return true;
  }
  const held = await fs.stat(path.join(lock, holder)).catch(() => null);
  if (held && Date.now() - held.mtimeMs <= LOCK_STALE_MS) return false;
  await quietly(fs.rm(path.join(lock, holder), { force: true }));
  await quietly(fs.rmdir(lock));
  return true;
}

/**
 * The lock is a directory holding one file named for its holder. It arrives whole,
 * by renaming a prepared directory into place, which succeeds only while no holder
 * is there. Returns the holder's file, which is all a release removes.
 */
async function takeLock(lock: string): Promise<string> {
  const holder = randomUUID();
  const prepared = `${lock}.${holder}`;
  await fs.mkdir(prepared);
  await fs.writeFile(path.join(prepared, holder), '');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.rename(prepared, lock);
      return path.join(lock, holder);
    } catch {
      // Held, or left behind: look, then try again.
    }
    if (await clearAbandoned(lock)) continue;
    if (Date.now() > deadline) {
      await quietly(fs.rm(prepared, { recursive: true, force: true }));
      throw new Error('Timed out waiting for another sync. process to finish with the sign-in.');
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

/**
 * Runs `task` while no other process sharing the store runs its own. Refresh tokens
 * rotate, so two servers refreshing at once would leave one holding a spent token.
 */
export async function withStoreLock<T>(task: () => Promise<T>): Promise<T> {
  const lock = storePath('mcp-credentials.lock');
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const held = await takeLock(lock);
  try {
    return await task();
  } finally {
    await quietly(fs.rm(held, { force: true }));
    await quietly(fs.rmdir(lock));
  }
}
