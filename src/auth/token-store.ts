import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

const PRODUCTION_API = 'https://api.sync.so';
const credentialsSchema = z.object({
  baseUrl: z.string(),
  token: z.string().min(1),
  expiresAt: z.string().optional(),
});
const CREDENTIALS_DIR = path.join(os.homedir(), '.config', 'sync');

function credentialLocation(baseUrl: string) {
  const url = new URL(baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol)
  ) {
    throw new Error('API base URL must be HTTP(S) without credentials, query, or fragment.');
  }
  const normalized = url.toString().replace(/\/+$/, '');
  const key = createHash('sha256').update(normalized).digest('hex');
  return { baseUrl: normalized, file: path.join(CREDENTIALS_DIR, `mcp-credentials-${key}.json`) };
}

export async function loadToken(baseUrl = PRODUCTION_API): Promise<string | null> {
  const location = credentialLocation(baseUrl);
  try {
    const result = credentialsSchema.safeParse(
      JSON.parse(await fs.readFile(location.file, 'utf8')),
    );
    if (!result.success || result.data.baseUrl !== location.baseUrl) return null;
    const creds = result.data;
    if (creds.expiresAt !== undefined) {
      const expiry = Date.parse(creds.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.now()) return null;
    }
    return creds.token;
  } catch {
    return null;
  }
}

export async function saveToken(
  token: string,
  expiresAt?: string,
  baseUrl = PRODUCTION_API,
): Promise<void> {
  const location = credentialLocation(baseUrl);
  await fs.mkdir(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  // Rename a private file atomically so concurrent readers never see partial JSON.
  const temp = await fs.mkdtemp(path.join(CREDENTIALS_DIR, '.credentials-'));
  const tempFile = path.join(temp, 'credentials.json');
  try {
    await fs.writeFile(tempFile, JSON.stringify({ token, expiresAt, baseUrl: location.baseUrl }), {
      mode: 0o600,
    });
    await fs.rename(tempFile, location.file);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function clearToken(baseUrl = PRODUCTION_API): Promise<void> {
  await fs.rm(credentialLocation(baseUrl).file, { force: true });
  // Old unscoped credentials are never loaded: their intended API is unknowable.
  if (credentialLocation(baseUrl).baseUrl === PRODUCTION_API) {
    await fs.rm(path.join(CREDENTIALS_DIR, 'mcp-credentials.json'), { force: true });
  }
}
