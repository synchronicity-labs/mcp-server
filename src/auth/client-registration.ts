import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import {
  CustomOAuthError,
  InvalidClientMetadataError,
} from '@modelcontextprotocol/server-legacy/auth';

/**
 * What a dynamically registered client may ask for (RFC 7591). Registration is open and
 * the API trusts this server's registration secret, so the rules live here: only
 * callbacks a real client uses, only the grants the API issues, and a short plain name.
 */

const ALLOWED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);
const MAX_REDIRECT_URIS = 20;
const MAX_REDIRECT_URI_LENGTH = 2_048;
export const MAX_CLIENT_NAME_LENGTH = 100;

// RFC 8252 section 7.3: a native app may listen on any port of a loopback address.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

// Private-use schemes of native clients that connect today. Cursor falls back to
// cursor://anysphere.cursor-mcp/oauth/callback; extensions in VS Code (and Insiders)
// such as Cline receive their callback through the editor's own scheme.
const NATIVE_APP_SCHEMES = new Set(['cursor:', 'vscode:', 'vscode-insiders:']);

// The callbacks of the hosted Claude and ChatGPT apps. A code sent to one of these
// reaches only that app, so registrations naming nothing else are cheap to allow.
const HOSTED_AGENT_CALLBACKS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
]);
const HOSTED_AGENT_CALLBACK_PREFIXES = ['https://chatgpt.com/connector/oauth/'];

function invalidRedirectUri(message: string): CustomOAuthError {
  return new CustomOAuthError('invalid_redirect_uri', message);
}

/** Why a redirect URI is refused, or null when it is allowed. */
export function redirectUriProblem(uri: string): string | null {
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return 'is too long';
  if (uri.includes('#')) return 'must not contain a fragment';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'is not a valid URL';
  }
  if (url.username || url.password) return 'must not contain user information';
  if (url.protocol === 'https:') return url.hostname ? null : 'must name a host';
  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname)
      ? null
      : 'must use https, or http on a loopback address';
  }
  if (NATIVE_APP_SCHEMES.has(url.protocol)) return null;
  return 'uses a scheme this server does not accept';
}

/** Control and formatting characters (including bidi overrides) never belong in a name. */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function sanitizeClientName(name: string | undefined): string | undefined {
  if (typeof name !== 'string') return undefined;
  const plain = name.replace(HIDDEN_CHARACTERS, '').replace(/\s+/g, ' ').trim();
  if (!plain) return undefined;
  return Array.from(plain).slice(0, MAX_CLIENT_NAME_LENGTH).join('');
}

/**
 * The registration request forwarded to the API: the fields above, checked, and nothing
 * else. Logos, homepages, contacts and other display metadata are dropped. The API defines
 * no scopes and never enforced a registered one, so no scope is registered either.
 * Throws an OAuth error the SDK returns as a 400.
 */
export function restrictRegistration(
  client: OAuthClientInformationFull,
): OAuthClientInformationFull {
  const redirectUris = (client.redirect_uris ?? []).map(String);
  if (redirectUris.length === 0) throw invalidRedirectUri('At least one redirect_uri is required');
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    throw invalidRedirectUri(`At most ${MAX_REDIRECT_URIS} redirect_uris are allowed`);
  }
  for (const uri of redirectUris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw invalidRedirectUri(`redirect_uri ${problem}`);
  }

  if (client.response_types && !client.response_types.includes('code')) {
    throw new InvalidClientMetadataError('response_types must include code');
  }

  // RFC 7591 lets the server replace requested values: keep the grants the API issues.
  let grantTypes: string[] | undefined;
  if (client.grant_types) {
    grantTypes = client.grant_types.filter((grant) => ALLOWED_GRANT_TYPES.has(grant));
    if (!grantTypes.includes('authorization_code')) {
      throw new InvalidClientMetadataError('grant_types must include authorization_code');
    }
    grantTypes = [...new Set(grantTypes)];
  }

  const clientName = sanitizeClientName(client.client_name);
  return {
    client_id: client.client_id,
    redirect_uris: redirectUris,
    ...(clientName && { client_name: clientName }),
    ...(grantTypes && { grant_types: grantTypes }),
    ...(client.token_endpoint_auth_method && {
      token_endpoint_auth_method: client.token_endpoint_auth_method,
    }),
  };
}

/** Whether every callback belongs to the hosted Claude or ChatGPT app. */
export function namesOnlyHostedAgentCallbacks(redirectUris: unknown): boolean {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) return false;
  return redirectUris.every(
    (uri) =>
      typeof uri === 'string' &&
      (HOSTED_AGENT_CALLBACKS.has(uri) ||
        HOSTED_AGENT_CALLBACK_PREFIXES.some(
          (prefix) => uri.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(uri.slice(prefix.length)),
        )),
  );
}
