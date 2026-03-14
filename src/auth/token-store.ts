import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

type StoredCredentials = {
  token: string;
  expiresAt?: string;
};

const CREDENTIALS_DIR = path.join(os.homedir(), '.config', 'sync');
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'mcp-credentials.json');

export async function loadToken(): Promise<string | null> {
  try {
    const content = await fs.readFile(CREDENTIALS_FILE, 'utf-8');
    const creds: StoredCredentials = JSON.parse(content);

    if (creds.expiresAt && new Date(creds.expiresAt) < new Date()) {
      return null;
    }

    return creds.token;
  } catch {
    return null;
  }
}

export async function saveToken(token: string, expiresAt?: string): Promise<void> {
  await fs.mkdir(CREDENTIALS_DIR, { recursive: true });
  const creds: StoredCredentials = { token, expiresAt };
  await fs.writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export async function clearToken(): Promise<void> {
  try {
    await fs.unlink(CREDENTIALS_FILE);
  } catch {
    // File doesn't exist, that's fine
  }
}
