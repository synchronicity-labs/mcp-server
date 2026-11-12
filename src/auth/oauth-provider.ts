import type { AuthInfo, OAuthClientInformationFull } from '@modelcontextprotocol/server';
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/server-legacy/auth';
import { createTokenVerifier } from './verification-cache.js';

const CONFIDENTIAL_CLIENT_AUTH_METHOD = 'client_secret_post';
const PUBLIC_CLIENT_AUTH_METHOD = 'none';
const NON_EXPIRING_CLIENT_SECRET = 0;

// The ChatGPT and Claude apps register asking for `none` but connect with the
// secret they are given, as they have since June 2026. They stay confidential;
// any other client that asks for `none` (Gemini, Gemini CLI) is public and
// signs in with PKCE alone.
const CONFIDENTIAL_AGENT_HOSTS = new Set(['chatgpt.com', 'claude.ai', 'claude.com']);

function hostOf(uri: string): string | null {
  try {
    return new URL(uri).hostname;
  } catch {
    return null;
  }
}

function isPublicClient(client: OAuthClientInformationFull): boolean {
  return (
    client.token_endpoint_auth_method === PUBLIC_CLIENT_AUTH_METHOD &&
    !client.redirect_uris.some((uri) => CONFIDENTIAL_AGENT_HOSTS.has(hostOf(String(uri)) ?? ''))
  );
}

function normalizeClientInfo(client: OAuthClientInformationFull): OAuthClientInformationFull {
  // A client the API gave a secret is confidential, whatever it asked for.
  const isPublic =
    !client.client_secret && client.token_endpoint_auth_method === PUBLIC_CLIENT_AUTH_METHOD;
  return {
    ...client,
    response_types: client.response_types ?? ['code'],
    token_endpoint_auth_method: isPublic
      ? PUBLIC_CLIENT_AUTH_METHOD
      : CONFIDENTIAL_CLIENT_AUTH_METHOD,
    ...(client.client_secret && client.client_secret_expires_at == null
      ? { client_secret_expires_at: NON_EXPIRING_CLIENT_SECRET }
      : {}),
  };
}

function forRegistration(client: OAuthClientInformationFull): OAuthClientInformationFull {
  return isPublicClient(client)
    ? client
    : { ...client, token_endpoint_auth_method: CONFIDENTIAL_CLIENT_AUTH_METHOD };
}

/**
 * Creates an OAuth provider that proxies to the Sync API's OAuth endpoints.
 *
 * Registered clients are cached in memory so the SDK's authorize handler can
 * look them up (it calls getClient before proxying the authorize request). The
 * cache doesn't survive a restart, so on a miss we read the client back from
 * the API (RFC 7592) — otherwise every redeploy would invalidate every
 * already-connected client with `invalid_client`.
 */
export function createOAuthProvider(
  apiBaseUrl: string,
  authorizationUrl = `${apiBaseUrl}/v2/oauth/authorize`,
): ProxyOAuthServerProvider & {
  verifyAccessToken(token: string, signal?: AbortSignal): Promise<AuthInfo>;
  clearVerificationCache(): void;
} {
  const verifier = createTokenVerifier(apiBaseUrl);
  const clientCache = new Map<string, OAuthClientInformationFull>();
  const registrationSecret = process.env.OAUTH_REGISTRATION_SECRET;

  const registrationUrl = `${apiBaseUrl}/v2/oauth/register`;

  // Cache-first client lookup with an API fallback. The API persists clients;
  // the in-memory cache is only a fast path that's empty after a restart.
  async function resolveClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const cached = clientCache.get(clientId);
    if (cached) return cached;

    try {
      const res = await fetch(`${registrationUrl}/${encodeURIComponent(clientId)}`, {
        headers: registrationSecret ? { Authorization: `Bearer ${registrationSecret}` } : {},
      });
      if (!res.ok) return undefined;
      const info = (await res.json()) as {
        client_id: string;
        client_name?: string;
        redirect_uris: string[];
        grant_types?: string[];
        response_types?: string[];
        scope?: string;
        client_secret?: string;
        client_secret_expires_at?: number;
        token_endpoint_auth_method?: string;
      };
      const client = normalizeClientInfo({
        client_id: info.client_id,
        client_secret: info.client_secret,
        client_secret_expires_at: info.client_secret_expires_at,
        redirect_uris: info.redirect_uris,
        client_name: info.client_name,
        grant_types: info.grant_types,
        response_types: info.response_types,
        scope: info.scope,
        token_endpoint_auth_method: info.token_endpoint_auth_method,
      });
      clientCache.set(client.client_id, client);
      return client;
    } catch {
      return undefined;
    }
  }

  const provider = new ProxyOAuthServerProvider({
    endpoints: {
      authorizationUrl,
      tokenUrl: `${apiBaseUrl}/v2/oauth/token`,
      revocationUrl: `${apiBaseUrl}/v2/oauth/revoke`,
      registrationUrl,
    },

    verifyAccessToken: verifier.verify,

    getClient: resolveClient,

    // Custom fetch that adds the registration secret header
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      if (typeof url === 'string' && url === registrationUrl && registrationSecret) {
        headers.set('Authorization', `Bearer ${registrationSecret}`);
      }
      return fetch(url, { ...init, headers });
    },
  });

  // Wrap the clientsStore so a freshly registered client is cached (fast path)
  // and lookups go through the cache-then-API resolver.
  const originalStore = provider.clientsStore;
  const originalRegister = originalStore.registerClient?.bind(originalStore);

  Object.defineProperty(provider, 'clientsStore', {
    get() {
      return {
        ...originalStore,
        getClient: resolveClient,
        ...(originalRegister && {
          registerClient: async (client: OAuthClientInformationFull) => {
            const registered = normalizeClientInfo(await originalRegister(forRegistration(client)));
            clientCache.set(registered.client_id, registered);
            return registered;
          },
        }),
      };
    },
  });

  return Object.assign(provider, {
    verifyAccessToken: verifier.verify,
    clearVerificationCache: verifier.clear,
  });
}
