import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

function normalizeClientInfo(client: OAuthClientInformationFull): OAuthClientInformationFull {
  return {
    ...client,
    response_types: client.response_types ?? ['code'],
    token_endpoint_auth_method: client.token_endpoint_auth_method ?? 'none',
  };
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
export function createOAuthProvider(apiBaseUrl: string): ProxyOAuthServerProvider {
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
        token_endpoint_auth_method?: string;
      };
      const client = normalizeClientInfo({
        client_id: info.client_id,
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
      authorizationUrl: `${apiBaseUrl}/v2/oauth/authorize`,
      tokenUrl: `${apiBaseUrl}/v2/oauth/token`,
      revocationUrl: `${apiBaseUrl}/v2/oauth/revoke`,
      registrationUrl,
    },

    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
      const res = await fetch(`${apiBaseUrl}/v2/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new InvalidTokenError('Invalid or expired token');
      }
      const info = (await res.json()) as {
        sub: string;
        client_id: string;
        expires_at?: number;
      };
      const expiresAt = info.expires_at ?? Math.floor(Date.now() / 1000) + 3600;
      return {
        token,
        clientId: info.client_id,
        scopes: [],
        expiresAt,
      };
    },

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
            const registered = normalizeClientInfo(await originalRegister(client));
            clientCache.set(registered.client_id, registered);
            return registered;
          },
        }),
      };
    },
  });

  return provider;
}
