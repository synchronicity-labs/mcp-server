import { combineSignals } from './abort-signals.js';
import { getAuthToken, getClientName } from './auth/async-context.js';

/**
 * Flagship assistant surfaces are first-class `x-sync-source` values in Sync
 * analytics; every other MCP client rides the `mcp:<client>` namespace (which
 * collapses to `mcp` in reporting). Keys are the lowercased `clientInfo.name`
 * each host reports in the MCP `initialize` handshake — verify the exact string
 * against a real connection when onboarding a new host (see the publishing
 * runbook) and add it here.
 */
// Keep openai-mcp namespaced: the deployed API selects bearer auth for mcp/mcp:*
// sources. Its ChatGPT presentation profile is independent of this transport header.
const FIRST_CLASS_SOURCE_BY_CLIENT: Record<string, string> = {
  chatgpt: 'chatgpt',
  openai: 'chatgpt',
  'openai-chatgpt': 'chatgpt',
  claude: 'claude',
  'claude-ai': 'claude',
  gemini: 'gemini',
  google: 'gemini',
};

export function resolveSyncSource(clientName?: string): string {
  if (!clientName) return 'mcp';
  return FIRST_CLASS_SOURCE_BY_CLIENT[clientName.toLowerCase()] ?? `mcp:${clientName}`;
}

// Bound upstream calls independently of the API-defined polling window. No write retries.
export const UPSTREAM_REQUEST_TIMEOUT_MS = 65_000;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
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
      signal?: AbortSignal;
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
export function createHttpClient(
  baseUrl: string,
  staticAuthHeaders: AuthHeaders = {},
  stdioClientName?: () => string | undefined,
): HttpClient {
  return {
    async request(method, path, options = {}) {
      const deadline = AbortSignal.timeout(UPSTREAM_REQUEST_TIMEOUT_MS);
      const { signal, dispose } = combineSignals(
        options.signal ? [options.signal, deadline] : [deadline],
      );
      try {
        signal.throwIfAborted();
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

        const clientName = getClientName() ?? stdioClientName?.();
        const syncSource = resolveSyncSource(clientName);

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
          signal,
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
            typeof parsed === 'object' &&
            parsed !== null &&
            'message' in parsed &&
            typeof parsed.message === 'string'
              ? parsed.message
              : text;
          const code =
            typeof parsed === 'object' &&
            parsed !== null &&
            'errorCode' in parsed &&
            typeof parsed.errorCode === 'string'
              ? parsed.errorCode
              : undefined;
          const retryAfter = response.headers.get('Retry-After');
          const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
          const retryAfterMs =
            Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
          throw new ApiRequestError(
            `API request failed: ${response.status} ${response.statusText} - ${message}`,
            response.status,
            code,
            retryAfterMs,
          );
        }

        return parsed;
      } finally {
        dispose();
      }
    },
  };
}
