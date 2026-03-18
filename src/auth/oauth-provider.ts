import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/**
 * Creates an OAuth provider that proxies to the Sync API's OAuth endpoints.
 *
 * Registered clients are cached in memory so the SDK's authorize handler
 * can look them up (it calls getClient before proxying the authorize request).
 */
export function createOAuthProvider(apiBaseUrl: string): ProxyOAuthServerProvider {
  // In-memory cache of registered clients, keyed by client_id.
  // Populated when registerClient is called by the SDK's registration handler.
  const clientCache = new Map<string, OAuthClientInformationFull>();

  const provider = new ProxyOAuthServerProvider({
    endpoints: {
      authorizationUrl: `${apiBaseUrl}/v2/oauth/authorize`,
      tokenUrl: `${apiBaseUrl}/v2/oauth/token`,
      revocationUrl: `${apiBaseUrl}/v2/oauth/revoke`,
      registrationUrl: `${apiBaseUrl}/v2/oauth/register`,
    },

    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
      const res = await fetch(`${apiBaseUrl}/v2/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error('Invalid token');
      }
      const info = (await res.json()) as {
        sub: string;
        client_id: string;
        expires_at?: number;
      };
      return {
        token,
        clientId: info.client_id,
        scopes: [],
        expiresAt: info.expires_at,
      };
    },

    getClient: async (clientId: string) => {
      return clientCache.get(clientId);
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
