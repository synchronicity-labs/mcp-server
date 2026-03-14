import { saveToken } from './token-store.js';

export type DeviceAuthToken = {
  type: 'bearer';
  headers: Record<string, string>;
};

type DeviceAuthStartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
};

type DeviceAuthPollResponse =
  | { status: 'pending' }
  | { status: 'ready'; accessToken: string; expiresAt?: string };

const POLL_INTERVAL_MS = 5000;
const CLIENT_ID = 'sync-mcp-server';

export async function performDeviceAuth(
  baseUrl: string,
  log: (message: string) => void,
): Promise<DeviceAuthToken> {
  const startResponse = await fetch(`${baseUrl}/v2/device-auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID }),
  });

  if (!startResponse.ok) {
    throw new Error(
      `Device auth start failed: ${startResponse.status} ${startResponse.statusText}`,
    );
  }

  const { deviceCode, userCode, verificationUri } =
    (await startResponse.json()) as DeviceAuthStartResponse;

  log(`\nTo authenticate, visit: ${verificationUri}\nEnter code: ${userCode}\n`);

  const { accessToken, expiresAt } = await pollForToken(baseUrl, deviceCode);
  await saveToken(accessToken, expiresAt);

  log('Authentication successful!\n');

  return {
    type: 'bearer',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-sync-source': 'mcp',
    },
  };
}

type PollResult = { accessToken: string; expiresAt?: string };

async function pollForToken(baseUrl: string, deviceCode: string): Promise<PollResult> {
  while (true) {
    await sleep(POLL_INTERVAL_MS);

    const pollResponse = await fetch(
      `${baseUrl}/v2/device-auth/poll?deviceCode=${encodeURIComponent(deviceCode)}`,
    );

    if (!pollResponse.ok) {
      if (pollResponse.status === 404) {
        throw new Error('Device auth code expired. Please try again.');
      }
      throw new Error(`Device auth poll failed: ${pollResponse.status} ${pollResponse.statusText}`);
    }

    const result = (await pollResponse.json()) as DeviceAuthPollResponse;

    if (result.status === 'ready') {
      return { accessToken: result.accessToken, expiresAt: result.expiresAt };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
