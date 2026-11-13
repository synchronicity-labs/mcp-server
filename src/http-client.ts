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

/**
 * What to do after a billing, plan, credit or limit refusal, as the API names it. type is
 * a string, not an enum: the API adds types (retry_later, upgrade_plan, buy_credits,
 * pay_invoice, update_payment_method, confirm_payment, reduce_input, manage_integration,
 * contact_support today) and an agent should still see one this server does not know.
 */
export const nextActionSchema = z
  .object({
    type: z.string().min(1).describe('What to do next, such as upgrade_plan or retry_later.'),
    url: z.string().optional().catch(undefined).describe('Page where a person does it.'),
    retryAfterSeconds: z
      .number()
      .nonnegative()
      .optional()
      .catch(undefined)
      .describe('Seconds to wait before sending the same request again.'),
    requiredPlan: z.string().optional().catch(undefined).describe('Plan that lifts the limit.'),
  })
  .describe('The API’s next action for this refusal. Act on it before anything else.');

// Error fields worth showing the agent as they are: what a refusal needs (its next action,
// a 402's plan, credits and billing page), a batch limit's counts, and the line a batch
// refusal points at.
const errorDetailsSchema = z.object({
  nextAction: nextActionSchema.optional().catch(undefined),
  requiredPlan: z.string().optional().catch(undefined),
  requiredCredits: z.number().int().positive().optional().catch(undefined),
  billingUrl: z.string().optional().catch(undefined),
  activeBatches: z.number().optional().catch(undefined),
  concurrencyLimit: z.number().optional().catch(undefined),
  lineNumber: z.number().int().positive().optional().catch(undefined),
});
export type ApiErrorDetails = z.infer<typeof errorDetailsSchema>;

export class ApiRequestError extends Error {
  /** Set by a tool that knows a better next step than the generic one for this code. */
  nextStep?: string;
  /** The API's own advice for this error code, when the response carries one. */
  suggestion?: string;

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

// The API's advice for a coded error, such as reconnecting to grant an organization.
function apiSuggestion(parsed: unknown): string | undefined {
  return z.object({ suggestion: z.string() }).safeParse(parsed).data?.suggestion;
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
/**
 * Fixed headers, or a function for a sign-in that renews itself between requests. Such a
 * sign-in can say what to do when the API stops accepting it.
 */
export type AuthSource = AuthHeaders | ((() => Promise<AuthHeaders>) & { signedOutStep?: string });

const sourceHeaders = async (source: AuthSource): Promise<AuthHeaders> =>
  typeof source === 'function' ? source() : source;

const signedOutStep = (status: number, source: AuthSource): string | undefined =>
  status === 401 && typeof source === 'function' ? source.signedOutStep : undefined;

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
 * 2. The stdio transport's own credential, set at startup: an API key or device token as
 *    fixed headers, or an emailed-code sign-in as a function that keeps it renewed
 */
export function createHttpClient(
  baseUrl: string,
  staticAuth: AuthSource = {},
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
          : { ...(await sourceHeaders(staticAuth)) };

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
          error.suggestion = apiSuggestion(parsed);
          error.nextStep = signedOutStep(response.status, staticAuth);
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
