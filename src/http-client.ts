import { getAuthToken, getClientName } from './auth/async-context.js';

// Fallback client name for stdio transport (single session, no AsyncLocalStorage)
let staticClientName: string | undefined;

export function setStaticClientName(name: string): void {
  staticClientName = name;
}

type AuthHeaders = Record<string, string>;

export type HttpClient = {
  request: (
    method: string,
    path: string,
    options?: {
      query?: Record<string, string>;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ) => Promise<unknown>;
};

/**
 * Creates an HTTP client for the Sync API.
 *
 * Auth is resolved in this order:
 * 1. Per-request token from AsyncLocalStorage (set by OAuth middleware in HTTP transport)
 * 2. Static auth headers (API key or device auth token, set at startup for stdio transport)
 */
export function createHttpClient(baseUrl: string, staticAuthHeaders: AuthHeaders = {}): HttpClient {
  return {
    async request(method, path, options = {}) {
      const url = new URL(path, baseUrl);
      if (options.query) {
        for (const [key, value] of Object.entries(options.query)) {
          if (value !== undefined && value !== '') {
            url.searchParams.set(key, value);
          }
        }
      }

      // Per-request OAuth token takes priority over static headers
      const perRequestToken = getAuthToken();
      const authHeaders: Record<string, string> = perRequestToken
        ? { Authorization: `Bearer ${perRequestToken}` }
        : { ...staticAuthHeaders };

      const clientName = getClientName() ?? staticClientName;
      const syncSource = clientName ? `mcp:${clientName}` : 'mcp';

      const headers: Record<string, string> = {
        ...authHeaders,
        'x-sync-source': syncSource,
        ...options.headers,
      };

      if (options.body && method !== 'get') {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(url.toString(), {
        method: method.toUpperCase(),
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      const text = await response.text();

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }

      if (!response.ok) {
        const message =
          typeof parsed === 'object' && parsed !== null && 'message' in parsed
            ? (parsed as { message: string }).message
            : text;
        throw new Error(
          `API request failed: ${response.status} ${response.statusText} - ${message}`,
        );
      }

      return parsed;
    },
  };
}
