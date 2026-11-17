import { createHash, timingSafeEqual } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { serializeError } from './runtime-diagnostics.js';

type LogEvent = (event: string, details?: Record<string, unknown>) => void;

/**
 * The last handler: an error no route answered (a malformed JSON or form body, a body
 * over its limit, a throw in middleware) becomes a short JSON response. Express's own
 * handler answers with HTML and, outside production, the stack trace. The stack goes to
 * the log only.
 */
export function finalErrorHandler(logEvent: LogEvent): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const declared = (error as { status?: unknown; statusCode?: unknown } | null) ?? {};
    const status = [declared.status, declared.statusCode].find(
      (value): value is number =>
        typeof value === 'number' && Number.isInteger(value) && value >= 400 && value < 600,
    );
    const clientError = status !== undefined && status < 500;
    logEvent('http_unhandled_error', {
      requestId: res.locals.requestId,
      httpMethod: req.method,
      path: req.path,
      statusCode: clientError ? status : 500,
      error: serializeError(error),
    });
    res.setHeader('Cache-Control', 'no-store');
    res
      .status(clientError ? status : 500)
      .json(
        clientError
          ? { error: 'invalid_request', error_description: 'The request could not be read' }
          : { error: 'server_error', error_description: 'Internal server error' },
      );
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * /status reports pod capacity for operators, not for signed-in users. It answers only a
 * bearer token equal to MCP_STATUS_TOKEN, and is not served when that is unset.
 */
export function requireStatusToken(expected: string | undefined): RequestHandler {
  const wanted = expected?.trim() ? digest(expected.trim()) : undefined;
  return (req, res, next) => {
    if (!wanted) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const header = req.headers.authorization;
    const supplied = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!supplied || !timingSafeEqual(digest(supplied), wanted)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    next();
  };
}
