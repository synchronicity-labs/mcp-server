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

/**
 * Accepted token and revocation requests per OAuth client. Client IDs are not secret,
 * so requests the API rejects never spend a client's allowance; they count against
 * the sender's address instead.
 */
export function createOAuthClientLimit() {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: REQUESTS_PER_MINUTE,
    skipFailedRequests: true,
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

const HOUR_MS = 60 * 60_000;
/** Registrations from one address that name a callback outside the hosted Claude and ChatGPT apps. */
export const REGISTRATIONS_PER_ADDRESS_PER_HOUR = 10;
/** Registrations from one address that name only hosted-app callbacks (shared egress). */
export const HOSTED_AGENT_REGISTRATIONS_PER_ADDRESS_PER_HOUR = 300;
/** Registrations on this pod, across addresses, that name a callback outside those apps. */
export const REGISTRATIONS_PER_HOUR = 1_000;

function registrationLimit(limit: number, keyGenerator?: (req: Request) => string) {
  return rateLimit({
    windowMs: HOUR_MS,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyGenerator && { keyGenerator }),
    message: {
      error: 'too_many_requests',
      error_description: 'Too many client registrations; try again later',
    },
  });
}

/**
 * Client registration limits, mounted after the body is parsed. Registration has no
 * signed-in user to limit by. The hosted Claude and ChatGPT apps register every
 * connection from a few shared addresses, and a code sent to their callbacks reaches only
 * them, so those registrations get a separate, larger allowance per address. Any other
 * registration counts against a small allowance per address and a pod-wide one.
 */
export function createRegistrationLimits(isHostedAgent: (req: Request) => boolean) {
  const hostedAgent = registrationLimit(HOSTED_AGENT_REGISTRATIONS_PER_ADDRESS_PER_HOUR, (req) =>
    addressKey(req),
  );
  const perAddress = registrationLimit(REGISTRATIONS_PER_ADDRESS_PER_HOUR, (req) =>
    addressKey(req),
  );
  const global = registrationLimit(REGISTRATIONS_PER_HOUR, () => 'registrations');
  return (req: Request, res: Response, next: (error?: unknown) => void) => {
    if (isHostedAgent(req)) {
      void hostedAgent(req, res, next);
      return;
    }
    void perAddress(req, res, (error?: unknown) => {
      if (error) next(error);
      else void global(req, res, next);
    });
  };
}
