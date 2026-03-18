import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export function createOAuthProvider(apiBaseUrl: string): ProxyOAuthServerProvider {
  return new ProxyOAuthServerProvider({
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

    getClient: async (_clientId: string) => {
      // ProxyOAuthServerProvider handles client registration via the proxy.
      // Return undefined to let the proxy endpoint handle it.
      return undefined;
    },
  });
}
