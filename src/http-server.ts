import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { InitializeRequestSchema } from '@modelcontextprotocol/core';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  createOAuthMetadata,
  InvalidRequestError,
  mcpAuthRouter,
  OAuthError,
} from '@modelcontextprotocol/server-legacy/auth';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { appUploadHandler, createAppUploadCors } from './app-upload-relay.js';
import { ASSET_THUMBNAIL_PLACEHOLDER } from './asset-thumbnail.js';
import { runWithAuth } from './auth/async-context.js';
import { requireBearerAuth } from './auth/bearer-auth.js';
import {
  BASIC_CHALLENGE,
  CLIENT_AUTH_METHODS,
  ClientAuthenticationError,
  mergeBasicClientCredentials,
} from './auth/client-credentials.js';
import {
  oauthFailureDiagnostics,
  oauthGrantType,
  oauthRequestDiagnostics,
} from './auth/oauth-diagnostics.js';
import { createOAuthProvider } from './auth/oauth-provider.js';
import { resourceMetadataUrl } from './auth/resource-metadata.js';
import type { SyncMcpConfig } from './config.js';
import { HttpSession, isSessionControlRequest } from './http-session.js';
import { readOAuthResponseText } from './oauth-response.js';
import { HttpRequestMetrics, serializeError } from './runtime-diagnostics.js';
import { SessionRegistry, sessionOwner } from './session-registry.js';
import { SessionTelemetry } from './session-telemetry.js';
import { uploadRuntime } from './upload-runtime.js';

export {
  extractBasicClientCredentials,
  mergeBasicClientCredentials,
} from './auth/client-credentials.js';

// Bound the entire credential exchange, including a stalled response body.
export const OAUTH_PROXY_TIMEOUT_MS = 10_000;

const OAUTH_FORM_FIELDS = [
  'grant_type',
  'code',
  'redirect_uri',
  'client_id',
  'client_secret',
  'code_verifier',
  'refresh_token',
  'scope',
  'resource',
  'token',
  'token_type_hint',
] as const;
const OPENAI_APPS_CHALLENGE_TOKEN =
  process.env.OPENAI_APPS_CHALLENGE_TOKEN || 'npwmwee4nxi0N3Rm14jmmsldnkv27qSnU3mY5rFCc5E';
const DEFAULT_SESSION_IDLE_TTL_MS = 2 * 60_000;
const DEFAULT_MAX_SESSIONS = 1_000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 15_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_RUNTIME_TELEMETRY_INTERVAL_MS = 15_000;
const MAX_REQUEST_ID_LENGTH = 128;

// Leave room for existing requests, JSON/UI responses and GC. Never evict an
// active session or replay an operation merely to admit a new connection.
export function hasSessionHeapCapacity(
  heap: Pick<
    ReturnType<typeof getHeapStatistics>,
    'used_heap_size' | 'heap_size_limit'
  > = getHeapStatistics(),
): boolean {
  return heap.used_heap_size < heap.heap_size_limit * 0.6;
}

// Collect reclaimable objects before refusing new sessions. Bound full-GC work
// during sustained pressure; keep the same headroom and never evict live work.
export function createSessionHeapAdmission({
  readHeap = getHeapStatistics,
  collect = global.gc,
  now = Date.now,
}: {
  readHeap?: () => Pick<ReturnType<typeof getHeapStatistics>, 'used_heap_size' | 'heap_size_limit'>;
  collect?: () => void;
  now?: () => number;
} = {}): () => boolean {
  let lastCollection = Number.NEGATIVE_INFINITY;
  return () => {
    if (hasSessionHeapCapacity(readHeap())) return true;
    const time = now();
    if (collect && time - lastCollection >= 30_000) {
      lastCollection = time;
      collect();
      return hasSessionHeapCapacity(readHeap());
    }
    return false;
  };
}

type SessionRuntimeConfig = {
  idleTtlMs: number;
  maxSessions: number;
  maxInFlightRequests: number;
  sweepIntervalMs: number;
  shutdownGraceMs: number;
  telemetryIntervalMs: number;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getSessionRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): SessionRuntimeConfig {
  return {
    idleTtlMs: positiveInteger(env.MCP_SESSION_IDLE_TTL_MS, DEFAULT_SESSION_IDLE_TTL_MS),
    maxSessions: positiveInteger(env.MCP_MAX_SESSIONS, DEFAULT_MAX_SESSIONS),
    maxInFlightRequests: positiveInteger(env.MCP_MAX_IN_FLIGHT_REQUESTS, 32),
    sweepIntervalMs: positiveInteger(
      env.MCP_SESSION_SWEEP_INTERVAL_MS,
      DEFAULT_SESSION_SWEEP_INTERVAL_MS,
    ),
    shutdownGraceMs: positiveInteger(env.MCP_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_GRACE_MS),
    telemetryIntervalMs: positiveInteger(
      env.MCP_RUNTIME_TELEMETRY_INTERVAL_MS,
      DEFAULT_RUNTIME_TELEMETRY_INTERVAL_MS,
    ),
  };
}

export async function runSessionSweepSafely(
  sessions: { sweep: () => Promise<unknown> },
  logEvent: (event: string, details: Record<string, unknown>) => void,
): Promise<void> {
  try {
    await sessions.sweep();
  } catch (error) {
    logEvent('mcp_session_sweep_error', { error: serializeError(error) });
  }
}

export function sanitizeDiagnosticUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

export function createRequestId(value: string | string[] | undefined): string {
  const requestId = value?.toString();
  return requestId && requestId.length <= MAX_REQUEST_ID_LENGTH ? requestId : randomUUID();
}

type HttpServerShutdownController = {
  close: (callback: (error?: Error) => void) => unknown;
  closeIdleConnections: () => void;
  closeAllConnections: () => void;
};

export function closeHttpServerWithGrace(
  httpServer: HttpServerShutdownController,
  graceMs: number,
): Promise<{ forced: boolean }> {
  let closed = false;
  let forced = false;
  let forceTimer: NodeJS.Timeout | undefined;
  const closing = new Promise<{ forced: boolean }>((resolve, reject) => {
    httpServer.close((error) => {
      closed = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve({ forced });
    });
  });
  httpServer.closeIdleConnections();
  if (!closed) {
    forceTimer = setTimeout(() => {
      forced = true;
      httpServer.closeAllConnections();
    }, graceMs);
    forceTimer.unref();
  }
  return closing;
}

export async function listenWithCleanup<T>(
  listen: () => T,
  waitForStartup: (server: T) => Promise<void>,
  cleanup: () => void,
): Promise<T> {
  try {
    const server = listen();
    await waitForStartup(server);
    return server;
  } catch (error) {
    cleanup();
    throw error;
  }
}

type HttpServerStartupEmitter = {
  on: (event: 'error', listener: (error: Error) => void) => unknown;
  once: (event: 'listening', listener: () => void) => unknown;
};

export function waitForHttpServerStartup(
  httpServer: HttpServerStartupEmitter,
  logEvent: (event: string, details: Record<string, unknown>) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let startupPending = true;
    httpServer.on('error', (error) => {
      logEvent('http_server_error', { error: serializeError(error) });
      if (startupPending) {
        startupPending = false;
        reject(error);
      }
    });
    httpServer.once('listening', () => {
      if (!startupPending) return;
      startupPending = false;
      resolve();
    });
  });
}

const TRUSTED_MCP_HOSTS = ['claude.ai', 'claude.com', 'chatgpt.com'] as const;
const TRUSTED_LOCAL_MCP_ORIGINS = new Set(['http://localhost:3000', 'http://localhost:5173']);

/**
 * Validate browser origins before an HTTP request reaches the MCP transport.
 * Non-browser MCP clients normally omit Origin, so an absent header is valid.
 */
export function isAllowedMcpOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (TRUSTED_LOCAL_MCP_ORIGINS.has(origin)) return true;

  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== 'https:' || url.port) return false;

    return TRUSTED_MCP_HOSTS.some(
      (trustedHost) => url.hostname === trustedHost || url.hostname.endsWith(`.${trustedHost}`),
    );
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function encodeOAuthFormBody(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const field of OAUTH_FORM_FIELDS) {
    const value = body[field];
    if (typeof value === 'string' && value !== '') {
      params.set(field, value);
    }
  }
  return params.toString();
}

/** Complete each POST with a JSON response, including large HTML resources. */
export function createHttpMcpTransport(
  options: ConstructorParameters<typeof NodeStreamableHTTPServerTransport>[0],
): NodeStreamableHTTPServerTransport {
  return new NodeStreamableHTTPServerTransport({ ...options, enableJsonResponse: true });
}

export async function startHttpServer(
  serverFactory: {
    createServer: (clientName?: string, handshakeClientName?: string) => McpServer;
    toolCount: number;
  },
  config: SyncMcpConfig,
): Promise<void> {
  const log = (message: string) => {
    process.stderr.write(message);
  };
  const logEvent = (event: string, details: Record<string, unknown> = {}) => {
    log(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        pod: process.env.HOSTNAME,
        revision:
          process.env.PORTER_TAG ?? process.env.GIT_SHA ?? process.env.K_REVISION ?? 'unknown',
        ...details,
      })}\n`,
    );
  };
  const requestMetrics = new HttpRequestMetrics();

  const app = express();
  app.set('trust proxy', 1);

  // Streamable HTTP servers must reject untrusted browser origins. Put this
  // before CORS so invalid preflight requests are rejected too.
  app.use('/mcp', (req, res, next) => {
    if (!isAllowedMcpOrigin(req.headers.origin)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    next();
  });

  const issuerUrl = new URL(process.env.MCP_ISSUER_URL || `http://localhost:${config.port}`);
  const oauthProvider = createOAuthProvider(config.baseUrl, config.oauthAuthorizationUrl);

  if (config.chatgptApp?.uploadStorageOrigin) {
    app.use(
      '/app-upload',
      createAppUploadCors(
        config.chatgptApp.uploadOrigins ?? [
          config.chatgptApp.domain,
          'https://web-sandbox.oaiusercontent.com',
        ],
      ),
    );
  }
  const mcpCors = cors({
    origin: (origin, callback) => callback(null, isAllowedMcpOrigin(origin)),
    credentials: true,
  });
  app.use((req, res, next) => (req.path === '/app-upload' ? next() : mcpCors(req, res, next)));

  // Structured request logging. Aggregate counters are also emitted in runtime heartbeats.
  app.use((req, res, next) => {
    const requestId = createRequestId(req.headers['x-request-id']);
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    const startedAt = performance.now();
    const finishMetrics = requestMetrics.start();
    let recorded = false;
    const record = (aborted: boolean) => {
      if (recorded) return;
      recorded = true;
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      finishMetrics({
        statusCode: res.statusCode,
        aborted,
        responseDelivered: res.writableFinished,
        durationMs,
      });
      logEvent('http_request', {
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        contentType: res.getHeader('content-type'),
        durationMs,
        aborted,
      });
    };
    res.once('finish', () => record(false));
    res.once('close', () => record(!res.writableFinished));
    next();
  });

  if (config.chatgptApp?.uploadStorageOrigin) {
    // No user bearer token enters the browser. The single-use ticket is issued only
    // after the authenticated assets/upload call has checked the account's limits.
    app.put('/app-upload', appUploadHandler);
  }

  app.get('/asset-placeholder.svg', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('image/svg+xml').send(ASSET_THUMBNAIL_PLACEHOLDER);
  });

  // Health check (unauthenticated)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/.well-known/openai-apps-challenge', (_req, res) => {
    res.type('text/plain').send(OPENAI_APPS_CHALLENGE_TOKEN);
  });

  // Favicon — proxy the Sync logo for connector branding
  app.get('/favicon.ico', async (_req, res) => {
    const upstream = await fetch('https://sync.so/favicon.ico');
    if (!upstream.ok) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/x-icon');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  });

  // ChatGPT may send client credentials via HTTP Basic Auth. Also, after an MCP
  // server restart, the SDK can recover registered client metadata but not the
  // raw client_secret. Proxy token/revoke requests with the incoming secret and
  // let the Sync API validate the confidential client.
  app.use(['/token', '/revoke'], express.urlencoded({ extended: false }));

  const oauthProxyRateLimit = rateLimit({ windowMs: 60_000, limit: 120 });
  const proxyOAuthFormRequest = async (
    path: 'token' | 'revoke',
    req: express.Request,
    res: express.Response,
  ) => {
    // Token responses must never be cached, including upstream error responses.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    const usesAuthorization = req.headers.authorization !== undefined;
    const body = asRecord(req.body);
    const requestDiagnostics = {
      requestId: res.locals.requestId,
      oauthPath: path,
      grantType: oauthGrantType(body.grant_type),
      authorizationHeaderPresent: usesAuthorization,
      ...oauthRequestDiagnostics(body, req.headers.authorization),
    };
    const logOAuthFailure = (source: string, statusCode: number, response: unknown) => {
      logEvent('oauth_exchange_rejected', {
        ...requestDiagnostics,
        source,
        statusCode,
        ...oauthFailureDiagnostics(response),
      });
    };
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      cancel();
    }, OAUTH_PROXY_TIMEOUT_MS);
    timeout.unref();
    req.once('aborted', cancel);
    res.once('close', cancel);
    if (req.aborted || res.destroyed) cancel();
    try {
      const authorizationCount = req.rawHeaders.filter(
        (header, index) => index % 2 === 0 && header.toLowerCase() === 'authorization',
      ).length;
      if (authorizationCount > 1)
        throw new InvalidRequestError('Multiple Authorization headers are not allowed');
      for (const field of OAUTH_FORM_FIELDS) {
        if (Object.hasOwn(body, field) && typeof body[field] !== 'string') {
          throw new InvalidRequestError('OAuth parameters must be single strings');
        }
      }
      const credentials = mergeBasicClientCredentials(body, req.headers.authorization);
      controller.signal.throwIfAborted();
      const upstream = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v2/oauth/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeOAuthFormBody(credentials),
        redirect: 'error',
        signal: controller.signal,
      });
      const responseBody = await readOAuthResponseText(upstream, controller.signal);
      if (controller.signal.aborted || res.destroyed) return;
      if (!upstream.ok) logOAuthFailure('upstream', upstream.status, responseBody);
      else {
        logEvent('oauth_exchange_succeeded', {
          ...requestDiagnostics,
          source: 'upstream',
          statusCode: upstream.status,
        });
      }
      if (upstream.status === 401 && usesAuthorization) {
        res.setHeader('WWW-Authenticate', BASIC_CHALLENGE);
      }
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      // Revoking a refresh token can invalidate its entire access-token family.
      if (path === 'revoke' && upstream.ok) oauthProvider.clearVerificationCache();
      res.status(upstream.status).send(responseBody);
    } catch (error) {
      if (res.destroyed) return;
      if (timedOut) {
        logOAuthFailure('timeout', 504, { error: 'temporarily_unavailable' });
        res.status(504).json({
          error: 'temporarily_unavailable',
          error_description: 'OAuth upstream request timed out',
        });
        return;
      }
      if (error instanceof OAuthError) {
        const status = error instanceof ClientAuthenticationError ? error.status : 400;
        logOAuthFailure('local', status, error.toResponseObject());
        if (status === 401) res.setHeader('WWW-Authenticate', BASIC_CHALLENGE);
        res.setHeader('Cache-Control', 'no-store');
        res.status(status).json(error.toResponseObject());
        return;
      }
      logEvent('oauth_proxy_error', {
        requestId: res.locals.requestId,
        oauthPath: path,
        error: { message: 'OAuth upstream request failed' },
      });
      if (!res.headersSent) {
        logOAuthFailure('transport', 502, { error: 'server_error' });
        res.status(502).json({ error: 'OAuth upstream request failed' });
      }
    } finally {
      clearTimeout(timeout);
      req.off('aborted', cancel);
      res.off('close', cancel);
    }
  };

  app.post('/token', oauthProxyRateLimit, (req, res) => {
    void proxyOAuthFormRequest('token', req, res);
  });

  app.post('/revoke', oauthProxyRateLimit, (req, res) => {
    void proxyOAuthFormRequest('revoke', req, res);
  });

  // OAuth auth router — handles /.well-known/*, /authorize, /token, /register, /revoke
  const mcpEndpointUrl = new URL('/mcp', issuerUrl);
  const serviceDocumentationUrl = new URL('https://sync.so/docs');

  // The Sync API OAuth backend issues confidential clients and requires a
  // client_secret at token time. The MCP SDK advertises both confidential and
  // public-client auth by default, so override the AS metadata before mounting
  // the SDK router to keep ChatGPT from registering as a public client.
  const confidentialOAuthMetadata = createOAuthMetadata({
    provider: oauthProvider,
    issuerUrl,
    serviceDocumentationUrl,
  });
  confidentialOAuthMetadata.token_endpoint_auth_methods_supported = CLIENT_AUTH_METHODS;
  confidentialOAuthMetadata.revocation_endpoint_auth_methods_supported = CLIENT_AUTH_METHODS;

  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json(confidentialOAuthMetadata);
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      resourceServerUrl: mcpEndpointUrl,
      serviceDocumentationUrl,
    }),
  );

  // MCP endpoint — requires valid Bearer token, rate limited
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    resourceMetadataUrl: resourceMetadataUrl(config.port),
  });
  const mcpRateLimit = rateLimit({ windowMs: 60_000, limit: 120 });

  const sessionRuntimeConfig = getSessionRuntimeConfig();
  const canAdmitRequest = createSessionHeapAdmission();
  const sessionTelemetry = new SessionTelemetry(logEvent);
  const sessions = new SessionRegistry<HttpSession>({
    idleTtlMs: sessionRuntimeConfig.idleTtlMs,
    maxSessions: sessionRuntimeConfig.maxSessions,
    canAdmit: canAdmitRequest,
    onRemove: (sessionId, reason) => {
      sessionTelemetry.close(sessionId, reason === 'closed' ? 'client_delete' : reason);
    },
    onCloseError: (error) => {
      logEvent('mcp_session_close_error', { error: serializeError(error) });
    },
  });

  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  app.get('/status', mcpRateLimit, bearerAuth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      sessions: sessions.stats(),
      requests: {
        inFlight: sessions.stats().inFlight,
        limit: sessionRuntimeConfig.maxInFlightRequests,
      },
      memory: {
        heapUsedBytes: process.memoryUsage().heapUsed,
        heapLimitBytes: getHeapStatistics().heap_size_limit,
      },
    });
  });
  const logRuntimeTelemetry = () => {
    const memory = process.memoryUsage();
    const resourceUsage = process.resourceUsage();
    const cpuUsage = process.cpuUsage();
    const eventLoopSampleCount = Number(eventLoopDelay.count);
    const eventLoop =
      eventLoopSampleCount > 0
        ? {
            samples: eventLoopSampleCount,
            minMs: Math.round((eventLoopDelay.min / 1e6) * 100) / 100,
            meanMs: Math.round((eventLoopDelay.mean / 1e6) * 100) / 100,
            p95Ms: Math.round((eventLoopDelay.percentile(95) / 1e6) * 100) / 100,
            p99Ms: Math.round((eventLoopDelay.percentile(99) / 1e6) * 100) / 100,
            maxMs: Math.round((eventLoopDelay.max / 1e6) * 100) / 100,
          }
        : { samples: 0 };
    logEvent('mcp_runtime', {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      sessions: sessions.stats(),
      requests: requestMetrics.snapshot(),
      uploads: uploadRuntime.snapshot(),
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        heapLimitBytes: getHeapStatistics().heap_size_limit,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
      cpu: {
        userMicros: cpuUsage.user,
        systemMicros: cpuUsage.system,
      },
      resources: {
        maxRssKb: resourceUsage.maxRSS,
        voluntaryContextSwitches: resourceUsage.voluntaryContextSwitches,
        involuntaryContextSwitches: resourceUsage.involuntaryContextSwitches,
        fsRead: resourceUsage.fsRead,
        fsWrite: resourceUsage.fsWrite,
      },
      eventLoop,
    });
    eventLoopDelay.reset();
  };

  const runtimeTelemetryInterval = setInterval(
    logRuntimeTelemetry,
    sessionRuntimeConfig.telemetryIntervalMs,
  );
  runtimeTelemetryInterval.unref();

  let sweepRunning = false;
  const sessionSweepInterval = setInterval(() => {
    if (sweepRunning) return;
    sweepRunning = true;
    void runSessionSweepSafely(sessions, logEvent).finally(() => {
      sweepRunning = false;
    });
  }, sessionRuntimeConfig.sweepIntervalMs);
  sessionSweepInterval.unref();

  // JSON body parsing for MCP requests
  app.use('/mcp', express.json());

  let shuttingDown = false;
  app.all('/mcp', mcpRateLimit, bearerAuth, async (req, res) => {
    const token = req.auth?.token;
    if (!token) {
      res.status(401).json({ error: 'Missing auth token' });
      return;
    }
    const owner = sessionOwner(req.auth);
    if (!owner) {
      res.status(403).json({ error: 'Verified session identity required' });
      return;
    }
    if (shuttingDown) {
      res.setHeader('Retry-After', '10');
      res.status(503).json({ error: 'MCP server is shutting down' });
      return;
    }

    let reservation: ReturnType<typeof sessions.reserve>;
    let lease: ReturnType<typeof sessions.acquire>;
    let initializedSessionId: string | undefined;
    try {
      const suppliedId = req.headers['mcp-session-id'];
      if (suppliedId !== undefined && typeof suppliedId !== 'string') {
        res.status(400).json({ error: 'Invalid session header' });
        return;
      }
      let sessionId = suppliedId;
      let session: HttpSession;
      const rpcMessages = (Array.isArray(req.body) ? req.body : [req.body]).map(asRecord);
      if (sessionId) {
        lease = sessions.acquire(sessionId, owner);
        if (!lease) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
        session = lease.transport;
      } else {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST, DELETE');
          res.status(405).end();
          return;
        }
        const init = InitializeRequestSchema.safeParse(req.body);
        if (!init.success) {
          res.status(400).json({ error: 'Initialize an MCP session before sending requests' });
          return;
        }
        reservation = sessions.reserve();
        if (!reservation) {
          res.setHeader('Retry-After', '60');
          res.status(503).json({ error: 'MCP session capacity reached' });
          return;
        }
        const id = randomUUID();
        sessionId = id;
        initializedSessionId = id;
        session = new HttpSession(
          init.data.params.clientInfo.name.slice(0, 160),
          serverFactory.createServer,
          (version) => sessionTelemetry.protocol(id, version),
          (details) =>
            logEvent('mcp_rpc_error', {
              ...details,
              sessionRef: sessionTelemetry.reference(id),
            }),
        );
        lease = reservation.commit(id, session, owner);
        reservation = undefined;
        sessionTelemetry.start(id, session.clientName, init.data.params.protocolVersion);
        res.setHeader('Mcp-Session-Id', id);
        logEvent('mcp_session_created', {
          sessionRef: sessionTelemetry.reference(id),
          requestId: res.locals.requestId,
        });
      }
      const correlation = initializedSessionId
        ? { sessionRef: sessionTelemetry.reference(sessionId) }
        : sessionTelemetry.request(
            sessionId,
            rpcMessages.flatMap((message) =>
              typeof message.method === 'string' ? [message.method] : [],
            ),
          );
      if (req.method === 'DELETE') {
        await sessions.remove(sessionId, 'closed');
        res.status(200).end();
        return;
      }
      // Let cancellation and lifecycle notifications through under pressure.
      if (req.method === 'POST' && !isSessionControlRequest(req.body)) {
        const refusal =
          sessions.stats().inFlight > sessionRuntimeConfig.maxInFlightRequests
            ? 'capacity'
            : !canAdmitRequest()
              ? 'memory'
              : undefined;
        if (refusal) {
          sessions.recordRejection(refusal);
          if (initializedSessionId) {
            await sessions.remove(initializedSessionId, 'initialization_failed');
            res.removeHeader('Mcp-Session-Id');
          }
          res.setHeader('Retry-After', '60');
          res.status(503).json({ error: 'MCP request capacity reached' });
          return;
        }
      }
      for (const rpcBody of rpcMessages) {
        if (typeof rpcBody.method !== 'string') continue;
        const rpcParams = asRecord(rpcBody.params);
        logEvent('mcp_rpc_request', {
          requestId: res.locals.requestId,
          method: rpcBody.method.slice(0, 80),
          ...correlation,
          ...(rpcBody.method === 'tools/call'
            ? {
                tool:
                  typeof rpcParams.name === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(rpcParams.name)
                    ? rpcParams.name
                    : '<other tool>',
              }
            : {}),
        });
      }
      await runWithAuth(token, session.clientName, () =>
        session.handleRequest(req, res, !!initializedSessionId),
      );
      if (initializedSessionId && res.statusCode >= 400)
        await sessions.remove(initializedSessionId, 'initialization_failed');
    } catch (error) {
      if (initializedSessionId)
        await sessions.remove(initializedSessionId, 'initialization_failed');
      logEvent('mcp_handler_error', {
        requestId: res.locals.requestId,
        error: serializeError(error),
      });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    } finally {
      lease?.release();
      reservation?.release();
    }
  });

  const onUncaughtException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
    logEvent('process_uncaught_exception', { origin, error: serializeError(error) });
  };
  const onWarning = (warning: Error) => {
    logEvent('process_warning', { error: serializeError(warning) });
  };
  const onExit = (code: number) => {
    logEvent('process_exit', {
      code,
      uptimeSeconds: Math.round(process.uptime()),
      sessions: sessions.stats(),
      requests: requestMetrics.snapshot(),
    });
  };
  process.on('uncaughtExceptionMonitor', onUncaughtException);
  process.on('warning', onWarning);
  process.once('exit', onExit);

  logEvent('process_start', {
    pid: process.pid,
    nodeVersion: process.version,
    sessionConfig: sessionRuntimeConfig,
  });

  const cleanupRuntimeResources = () => {
    clearInterval(sessionSweepInterval);
    clearInterval(runtimeTelemetryInterval);
    eventLoopDelay.disable();
    process.off('uncaughtExceptionMonitor', onUncaughtException);
    process.off('warning', onWarning);
    process.off('exit', onExit);
  };
  const httpServer = await listenWithCleanup(
    () => app.listen(config.port),
    async (server) => {
      server.on('close', () => {
        logEvent('http_server_closed');
      });
      await waitForHttpServerStartup(server, logEvent);
    },
    cleanupRuntimeResources,
  );
  logEvent('server_listening', {
    port: config.port,
    issuer: issuerUrl.origin,
    apiBaseUrl: sanitizeDiagnosticUrl(config.baseUrl),
    registeredToolCount: serverFactory.toolCount,
  });
  logRuntimeTelemetry();

  const shutdown = async (reason: 'SIGTERM' | 'SIGINT') => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('shutdown_started', {
      reason,
      sessions: sessions.stats(),
      requests: requestMetrics.snapshot(),
    });
    logRuntimeTelemetry();
    clearInterval(sessionSweepInterval);
    clearInterval(runtimeTelemetryInterval);
    eventLoopDelay.disable();

    // Stop admission first, then let requests and initializations already in progress drain.
    const httpServerClosing = closeHttpServerWithGrace(
      httpServer,
      sessionRuntimeConfig.shutdownGraceMs,
    );
    const deadline = Date.now() + sessionRuntimeConfig.shutdownGraceMs;
    let runtimeStats = sessions.stats();
    while ((runtimeStats.pending > 0 || runtimeStats.inFlight > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      runtimeStats = sessions.stats();
    }
    if (runtimeStats.pending > 0 || runtimeStats.inFlight > 0) {
      logEvent('shutdown_grace_expired', { sessions: runtimeStats });
    }

    // Freeze reservations before taking final snapshots so late initialization cannot escape cleanup.
    sessions.stopAccepting();
    await sessions.closeAll();
    const httpServerClose = await httpServerClosing;
    logEvent('shutdown_completed', {
      reason,
      forcedHttpConnectionsClosed: httpServerClose.forced,
      sessions: sessions.stats(),
      requests: requestMetrics.snapshot(),
    });
  };
  const requestShutdown = (reason: 'SIGTERM' | 'SIGINT') => {
    void shutdown(reason).catch((error) => {
      logEvent('shutdown_error', { reason, error: serializeError(error) });
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', () => requestShutdown('SIGTERM'));
  process.once('SIGINT', () => requestShutdown('SIGINT'));
}
