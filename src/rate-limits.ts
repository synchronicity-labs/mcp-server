import type { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { mergeBasicClientCredentials } from './auth/client-credentials.js';
import { sessionOwner } from './session-registry.js';

// Hosted clients such as ChatGPT and Claude.ai reach this server from a few shared
// egress addresses, so a per-address limit would make all of their users share one
// bucket. Ordinary traffic is limited per signed-in user or OAuth client instead.
// Per address, only rejected requests count, which still bounds credential floods
// (each invalid token costs an upstream verification) without capping that traffic.
const WINDOW_MS = 60_000;
const REQUESTS_PER_MINUTE = 120;
const REJECTED_PER_MINUTE = 300;

function addressKey(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

function rejectedRequestLimit(rejectedStatuses: readonly number[]) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: REJECTED_PER_MINUTE,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req: Request, res: Response) =>
      !rejectedStatuses.includes(res.statusCode),
  });
}

/** Before bearer authentication: rejected credentials per address. */
export function createMcpRejectedCredentialLimit() {
  return rejectedRequestLimit([401, 403]);
}

/** After bearer authentication: requests per verified user, OAuth client and organization. */
export function createMcpUserLimit() {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: REQUESTS_PER_MINUTE,
    keyGenerator: (req) => {
      const owner = sessionOwner(req.auth);
      return owner
        ? `user:${JSON.stringify([owner.sub, owner.clientId, owner.organizationId])}`
        : addressKey(req);
    },
  });
}

/** Token and revocation requests the API rejected, per address. */
export function createOAuthRejectedRequestLimit() {
  return rejectedRequestLimit([400, 401, 403]);
}

/** Token and revocation requests per OAuth client; the API still authenticates the client. */
export function createOAuthClientLimit() {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: REQUESTS_PER_MINUTE,
    keyGenerator: (req) => {
      const body: unknown = req.body;
      try {
        const clientId = mergeBasicClientCredentials(
          typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {},
          req.headers.authorization,
        ).client_id;
        if (typeof clientId === 'string') return `client:${clientId}`;
      } catch {
        // Malformed credentials fail in the proxy; count them by address here.
      }
      return addressKey(req);
    },
  });
}
