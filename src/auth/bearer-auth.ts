import {
  type BearerAuthMiddlewareOptions,
  requireBearerAuth as sdkRequireBearerAuth,
} from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { RequestHandler } from 'express';
import { VerificationUnavailableError } from './token-verification.js';

type Options = Omit<BearerAuthMiddlewareOptions, 'verifier'> & {
  verifier: { verifyAccessToken(token: string, signal?: AbortSignal): Promise<AuthInfo> };
};

/** Preserve SDK authentication checks; only translate dependency failures locally. */
export function requireBearerAuth(options: Options): RequestHandler {
  return async (req, res, next) => {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return sdkRequireBearerAuth(options)(req, res, next);
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.once('aborted', cancel);
    res.once('close', cancel);
    if (req.aborted || res.destroyed) cancel();
    let auth: AuthInfo | undefined;
    let failure: unknown;
    try {
      auth = await options.verifier.verifyAccessToken(token, controller.signal);
    } catch (error) {
      failure = error;
    } finally {
      req.off('aborted', cancel);
      res.off('close', cancel);
    }
    if (controller.signal.aborted || res.destroyed) return;
    if (failure instanceof VerificationUnavailableError) {
      res.set('Cache-Control', 'no-store');
      if (failure.retryAfter) res.set('Retry-After', failure.retryAfter);
      res.status(failure.status).json(failure.toResponseObject());
      return;
    }
    // SDK still owns invalid-token challenges, expiration and scope enforcement.
    return sdkRequireBearerAuth({
      ...options,
      verifier: {
        verifyAccessToken: async () => {
          if (failure) throw failure;
          if (!auth) throw new Error('Token verification failed');
          return auth;
        },
      },
    })(req, res, next);
  };
}
