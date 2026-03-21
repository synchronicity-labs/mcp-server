import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * Creates an OAuth provider that proxies to the Sync API's OAuth endpoints.
 *
 * Registered clients are cached in memory so the SDK's authorize handler
 * can look them up (it calls getClient before proxying the authorize request).
 */
export function createOAuthProvider(apiBaseUrl: string): ProxyOAuthServerProvider {
  const clientCache = new Map<string, OAuthClientInformationFull>();
  const registrationSecret = process.env.OAUTH_REGISTRATION_SECRET;

  const registrationUrl = `${apiBaseUrl}/v2/oauth/register`;

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

    getClient: async (clientId: string) => {
      return clientCache.get(clientId);
    },

    // Custom fetch that adds the registration secret header
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      if (typeof url === 'string' && url === registrationUrl && registrationSecret) {
        headers.set('Authorization', `Bearer ${registrationSecret}`);
      }
      return fetch(url, { ...init, headers });
    },
  });

  // Wrap the clientsStore to cache registered clients
  const originalStore = provider.clientsStore;
  const originalRegister = originalStore.registerClient?.bind(originalStore);

  Object.defineProperty(provider, 'clientsStore', {
    get() {
      return {
        ...originalStore,
        getClient: async (clientId: string) => clientCache.get(clientId),
        ...(originalRegister && {
          registerClient: async (client: OAuthClientInformationFull) => {
            const registered = await originalRegister(client);
            clientCache.set(registered.client_id, registered);
            return registered;
          },
        }),
      };
    },
  });

  return provider;
}
