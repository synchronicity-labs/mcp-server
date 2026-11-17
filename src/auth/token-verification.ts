import type { AuthInfo } from '@modelcontextprotocol/server';
import {
  InvalidTokenError,
  TemporarilyUnavailableError,
} from '@modelcontextprotocol/server-legacy/auth';
import { z } from 'zod';

export const VERIFICATION_TIMEOUT_MS = 5_000;

// Never include upstream bodies, exceptions, or credentials in public errors.
export class VerificationUnavailableError extends TemporarilyUnavailableError {
  constructor(
    readonly status: 429 | 502 | 503 = 503,
    readonly retryAfter?: string,
  ) {
    super('Token verification is temporarily unavailable');
  }
}

export function parseRetryAfter(value: string | null): string | undefined {
  if (!value) return undefined;
  if (/^\d{1,15}$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  // Accept canonical IMF-fixdate only, not Date.parse's permissive numeric forms.
  const time = Date.parse(value);
  if (Number.isFinite(time) && new Date(time).toUTCString() === value) return value;
  return undefined;
}

const userInfoSchema = z.object({
  sub: z.string().refine((value) => value.trim().length > 0),
  client_id: z.string().refine((value) => value.trim().length > 0),
  expires_at: z.number().int().positive().optional(),
  organization_id: z
    .string()
    .refine((value) => value.trim().length > 0)
    .optional(),
  // RFC 8707 / RFC 9068 audience. The API does not report one yet; see audienceMatches.
  aud: z.union([z.string(), z.array(z.string())]).optional(),
});

function normalizeAudience(value: string): string | undefined {
  try {
    const url = new URL(value);
    // Only a trailing slash is ignored; a query or fragment names a different resource.
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether a token may be used here. A token whose userinfo names no audience is accepted,
 * as every token is today; once the API reports `aud`, a token must name this server.
 */
export function audienceMatches(
  aud: string | readonly string[] | undefined,
  accepted: readonly string[],
): boolean {
  if (aud === undefined || accepted.length === 0) return true;
  const wanted = new Set(accepted.map(normalizeAudience));
  return (typeof aud === 'string' ? [aud] : aud).some((value) =>
    wanted.has(normalizeAudience(value)),
  );
}

export async function verifySyncAccessToken(
  apiBaseUrl: string,
  token: string,
  signal?: AbortSignal,
  audiences: readonly string[] = [],
): Promise<AuthInfo> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, VERIFICATION_TIMEOUT_MS);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new VerificationUnavailableError());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  try {
    // Race the whole body read as well as headers. Abort also closes native fetch I/O.
    return await Promise.race([
      aborted,
      (async () => {
        if (controller.signal.aborted) throw new VerificationUnavailableError();
        const res = await fetch(`${apiBaseUrl}/v2/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
          redirect: 'error',
        });
        if (!res.ok) {
          const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
          void res.body?.cancel().catch(() => {});
          if (res.status === 401 || res.status === 403) {
            throw new InvalidTokenError('Invalid or expired token');
          }
          throw new VerificationUnavailableError(
            res.status === 429 ? 429 : res.status >= 500 ? 503 : 502,
            retryAfter,
          );
        }
        const parsed = userInfoSchema.safeParse(await res.json());
        if (!parsed.success) throw new VerificationUnavailableError(502);
        if (!audienceMatches(parsed.data.aud, audiences)) {
          throw new InvalidTokenError('Token was not issued for this server');
        }
        return {
          token,
          clientId: parsed.data.client_id,
          // Stable verified identity for A's session ownership checks. Never use
          // token bytes/expiry or copy arbitrary upstream fields into this object.
          extra: {
            sub: parsed.data.sub,
            ...(parsed.data.organization_id === undefined
              ? {}
              : { organizationId: parsed.data.organization_id }),
          },
          scopes: [],
          // Preserve the legacy expiry fallback; the provider bounds reuse to 15 seconds.
          expiresAt: parsed.data.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
        };
      })(),
    ]);
  } catch (error) {
    if (error instanceof InvalidTokenError || error instanceof VerificationUnavailableError)
      throw error;
    throw new VerificationUnavailableError(error instanceof SyntaxError ? 502 : 503);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
