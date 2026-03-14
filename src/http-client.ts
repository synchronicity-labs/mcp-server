const SYNC_SOURCE = 'mcp';

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

export function createHttpClient(baseUrl: string, authHeaders: AuthHeaders): HttpClient {
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

      const headers: Record<string, string> = {
        ...authHeaders,
        'x-sync-source': SYNC_SOURCE,
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
