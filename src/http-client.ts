import { z } from 'zod';
import { combineSignals } from './abort-signals.js';
import { getAuthToken, getClientName } from './auth/async-context.js';
import { chosenOrganization, ORGANIZATION_HEADER } from './organization-selection.js';
import { getToolAnalytics } from './tool-analytics-context.js';
import { PACKAGE_VERSION } from './version.js';

/** API-key analytics labels; bearer credentials use the API's MCP source namespace. */
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

/**
 * Who is calling: the analytics source, this server's version and the MCP client's
 * handshake name when known. The API ignores headers it does not record.
 */
function clientHeaders(
  authHeaders: AuthHeaders,
  clientName: string | undefined,
): Record<string, string> {
  const syncSource = authHeaders.Authorization?.startsWith('Bearer ')
    ? clientName
      ? `mcp:${clientName}`
      : 'mcp'
    : resolveSyncSource(clientName);
  return {
    'x-sync-source': syncSource,
    'x-sync-mcp-version': PACKAGE_VERSION,
    ...(clientName ? { 'x-sync-mcp-client': clientName } : {}),
  };
}

// Bound upstream calls independently of the API-defined polling window. No write retries.
export const UPSTREAM_REQUEST_TIMEOUT_MS = 65_000;

const importErrorDetailsSchema = z.object({
  importJobId: z.uuid().optional(),
  importStatus: z.enum(['queued', 'downloading', 'processing', 'completed', 'failed']).optional(),
  progress: z.number().min(0).max(100).optional(),
});

// Error fields worth showing the agent as they are: what a refusal needs (a 402's plan and
// billing page), a batch limit's counts, and the line a batch refusal points at.
const errorDetailsSchema = z.object({
  requiredPlan: z.string().optional().catch(undefined),
  billingUrl: z.string().optional().catch(undefined),
  activeBatches: z.number().optional().catch(undefined),
  concurrencyLimit: z.number().optional().catch(undefined),
  lineNumber: z.number().int().positive().optional().catch(undefined),
});
export type ApiErrorDetails = z.infer<typeof errorDetailsSchema>;

export class ApiRequestError extends Error {
  /** Set by a tool that knows a better next step than the generic one for this code. */
  nextStep?: string;

  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterMs?: number,
    readonly generationId?: string,
    readonly importDetails?: z.infer<typeof importErrorDetailsSchema>,
    readonly details?: ApiErrorDetails,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

function errorDetails(parsed: unknown): ApiErrorDetails | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const details = errorDetailsSchema.parse(parsed);
  const present = Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  );
  return Object.keys(present).length > 0 ? present : undefined;
}

// Errors built from an API response, as opposed to this server's own checks.
const apiResponseErrors = new WeakSet<ApiRequestError>();

export function cameFromApi(error: unknown): boolean {
  return error instanceof ApiRequestError && apiResponseErrors.has(error);
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
        const url = new URL(path.replace(/^\//, ''), `${baseUrl.replace(/\/$/, '')}/`);
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

        const organization = chosenOrganization();
        const headers: Record<string, string> = {
          ...authHeaders,
          ...clientHeaders(authHeaders, getClientName() ?? stdioClientName?.()),
          ...(organization ? { [ORGANIZATION_HEADER]: organization.id } : {}),
          ...options.headers,
          ...(getToolAnalytics() && { 'x-sync-analytics': JSON.stringify(getToolAnalytics()) }),
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
          const knownId = z
            .uuid()
            .safeParse(
              parsed && typeof parsed === 'object' && 'generationId' in parsed
                ? parsed.generationId
                : undefined,
            );
          const importDetails =
            code === 'import_in_progress' || code === 'import_failed'
              ? importErrorDetailsSchema.safeParse(parsed)
              : undefined;
          const error = new ApiRequestError(
            `API request failed: ${response.status} ${response.statusText} - ${message}`,
            response.status,
            code,
            retryAfterMs,
            knownId.success ? knownId.data : undefined,
            importDetails?.success ? importDetails.data : undefined,
            errorDetails(parsed),
          );
          apiResponseErrors.add(error);
          throw error;
        }

        return parsed;
      } finally {
        dispose();
      }
    },
  };
}
