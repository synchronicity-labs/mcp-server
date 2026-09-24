import {
  InvalidClientError,
  InvalidRequestError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

// Basic is an existing ChatGPT compatibility path; both methods become a single
// confidential body-secret request to Sync. Public clients are not supported.
export const CLIENT_AUTH_METHODS = ['client_secret_post', 'client_secret_basic'];
export const BASIC_CHALLENGE = 'Basic realm="oauth"';

export class ClientAuthenticationError extends InvalidClientError {
  constructor(readonly status: 400 | 401) {
    super('Invalid client authentication');
  }
}

export function extractBasicClientCredentials(
  authorization: string | undefined,
): { clientId: string; clientSecret: string } | undefined {
  if (authorization === undefined) return undefined;
  const match = /^Basic +([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (!match?.[1]) throw new ClientAuthenticationError(401);
  try {
    const bytes = Buffer.from(match[1], 'base64');
    // Buffer's base64 decoder otherwise silently ignores malformed input.
    if (
      bytes.toString('base64').replace(/=+$/, '') !== match[1].replace(/=+$/, '') ||
      (match[1].includes('=') && bytes.toString('base64') !== match[1])
    )
      throw new Error();
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const colon = decoded.indexOf(':');
    if (colon < 0) throw new Error();
    const decode = (value: string) => decodeURIComponent(value.replace(/\+/g, ' '));
    const clientId = decode(decoded.slice(0, colon));
    const clientSecret = decode(decoded.slice(colon + 1));
    if (!clientId || !clientSecret) throw new Error();
    return { clientId, clientSecret };
  } catch {
    throw new ClientAuthenticationError(401);
  }
}

export function mergeBasicClientCredentials(
  body: Record<string, unknown>,
  authorization: string | undefined,
): Record<string, unknown> {
  // RFC 6749 2.3: one authentication method per request, even if values match.
  if (
    authorization !== undefined &&
    (Object.hasOwn(body, 'client_id') || Object.hasOwn(body, 'client_secret'))
  ) {
    throw new InvalidRequestError('Multiple client authentication methods are not allowed');
  }
  if (Object.hasOwn(body, 'client_assertion') || Object.hasOwn(body, 'client_assertion_type')) {
    throw new InvalidRequestError('Unsupported client authentication method');
  }
  for (const key of ['client_id', 'client_secret']) {
    if (Object.hasOwn(body, key) && typeof body[key] !== 'string') {
      throw new InvalidRequestError('Client credentials must be single strings');
    }
  }
  const basic = extractBasicClientCredentials(authorization);
  if (basic) return { ...body, client_id: basic.clientId, client_secret: basic.clientSecret };
  if (
    typeof body.client_id !== 'string' ||
    !body.client_id ||
    typeof body.client_secret !== 'string' ||
    !body.client_secret
  ) {
    throw new ClientAuthenticationError(400);
  }
  return { ...body };
}
