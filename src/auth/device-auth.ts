import { z } from 'zod';
import { saveToken } from './token-store.js';

export type DeviceAuthToken = {
  type: 'bearer';
  headers: Record<string, string>;
};

const startSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.url(),
  expiresIn: z.number().int().positive().max(86400),
  interval: z.number().int().positive().max(86400),
});
const pollSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('ready'),
    accessToken: z.string().min(1),
    expiresIn: z.number().int().positive(),
  }),
]);
const REQUEST_TIMEOUT_MS = 30000;
const CLIENT_ID = 'sync-mcp-server';
const expired = () => new Error('Device auth code expired. Please try again.');

export async function performDeviceAuth(
  baseUrl: string,
  log: (message: string) => void,
): Promise<DeviceAuthToken> {
  const startedAt = Date.now();
  const startResponse = await fetch(`${baseUrl.replace(/\/+$/, '')}/v2/device-auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!startResponse.ok) {
    throw new Error(
      `Device auth start failed: ${startResponse.status} ${startResponse.statusText}`,
    );
  }
  const parsed = startSchema.safeParse(await startResponse.json());
  if (!parsed.success) throw new Error('Invalid device auth start response.');
  const { deviceCode, userCode, verificationUri, expiresIn, interval } = parsed.data;
  const deadline = startedAt + expiresIn * 1000;
  log(
    `\nTo authenticate, visit: ${verificationUri}\nEnter code: ${userCode}\nExpires in ${expiresIn} seconds.\n`,
  );

  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(interval * 1000, deadline - Date.now())),
    );
    if (Date.now() >= deadline) throw expired();
    const polledAt = Date.now();
    const pollResponse = await fetch(
      `${baseUrl.replace(/\/+$/, '')}/v2/device-auth/poll?deviceCode=${encodeURIComponent(deviceCode)}`,
      { signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, deadline - polledAt)) },
    );
    if (pollResponse.status === 404 || Date.now() >= deadline) throw expired();
    if (!pollResponse.ok) {
      throw new Error(`Device auth poll failed: ${pollResponse.status} ${pollResponse.statusText}`);
    }
    const parsedPoll = pollSchema.safeParse(await pollResponse.json());
    // Do not include response bodies or validation details: they may contain tokens.
    if (!parsedPoll.success) throw new Error('Invalid device auth poll response.');
    const result = parsedPoll.data;
    if (result.status === 'expired') throw expired();
    if (result.status === 'pending') continue;
    const expiresAt = new Date(polledAt + result.expiresIn * 1000).toISOString();
    await saveToken(result.accessToken, expiresAt, baseUrl);
    log('Authentication successful!\n');
    return {
      type: 'bearer',
      headers: { Authorization: `Bearer ${result.accessToken}`, 'x-sync-source': 'mcp' },
    };
  }
  throw expired();
}
