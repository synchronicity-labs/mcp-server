import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import {
  createOAuthMetadata,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { runWithAuth } from './auth/async-context.js';
import { requireBearerAuth } from './auth/bearer-auth.js';
import { createOAuthProvider } from './auth/oauth-provider.js';
import type { SyncMcpConfig } from './config.js';
import { HttpRequestMetrics, serializeError } from './runtime-diagnostics.js';
import { SessionRegistry } from './session-registry.js';
import { uploadRuntime } from './upload-runtime.js';

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
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_SESSIONS = 1_000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_RUNTIME_TELEMETRY_INTERVAL_MS = 15_000;
const MAX_REQUEST_ID_LENGTH = 128;

type SessionRuntimeConfig = {
  idleTtlMs: number;
  maxSessions: number;
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function extractBasicClientCredentials(
  authorization: string | undefined,
): { clientId: string; clientSecret?: string } | undefined {
  if (!authorization?.startsWith('Basic ')) return undefined;

  try {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString();
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) return undefined;

    const clientId = decodeURIComponent(decoded.slice(0, separatorIndex));
    const encodedSecret = decoded.slice(separatorIndex + 1);
    const clientSecret = encodedSecret ? decodeURIComponent(encodedSecret) : undefined;
    return clientId ? { clientId, clientSecret } : undefined;
  } catch {
    return undefined;
  }
}

export function mergeBasicClientCredentials(
  body: Record<string, unknown>,
  authorization: string | undefined,
): Record<string, unknown> {
  if (typeof body.client_id === 'string' && body.client_id) return body;

  const credentials = extractBasicClientCredentials(authorization);
  if (!credentials) return body;

  return {
    ...body,
    client_id: credentials.clientId,
    ...(credentials.clientSecret ? { client_secret: credentials.clientSecret } : {}),
  };
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

export async function startHttpServer(
  serverFactory: { createServer: () => McpServer; toolCount: number },
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

  const issuerUrl = new URL(process.env.MCP_ISSUER_URL || `http://localhost:${config.port}`);
  const oauthProvider = createOAuthProvider(config.baseUrl);

  // CORS for browser-based MCP clients
  app.use(
    cors({
      origin: [
        'https://claude.ai',
        /^https:\/\/.*\.claude\.ai$/,
        'https://claude.com',
        /^https:\/\/.*\.claude\.com$/,
        'https://chatgpt.com',
        /^https:\/\/.*\.chatgpt\.com$/,
        'http://localhost:3000',
        'http://localhost:5173',
      ],
      credentials: true,
    }),
  );

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
        durationMs,
        aborted,
      });
    };
    res.once('finish', () => record(false));
    res.once('close', () => record(!res.writableFinished));
    next();
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
  app.use(['/token', '/revoke'], express.urlencoded({ extended: false }), (req, _res, next) => {
    req.body = mergeBasicClientCredentials(asRecord(req.body), req.headers.authorization);
    next();
  });

  const oauthProxyRateLimit = rateLimit({ windowMs: 60_000, limit: 120 });
  const proxyOAuthFormRequest = async (
    path: 'token' | 'revoke',
    req: express.Request,
    res: express.Response,
  ) => {
    try {
      const upstream = await fetch(new URL(`/v2/oauth/${path}`, config.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeOAuthFormBody(asRecord(req.body)),
      });
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      res.status(upstream.status).send(await upstream.text());
    } catch (error) {
      logEvent('oauth_proxy_error', {
        requestId: res.locals.requestId,
        oauthPath: path,
        error: serializeError(error),
      });
      if (!res.headersSent) {
        res.status(502).json({ error: 'OAuth upstream request failed' });
      }
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
  confidentialOAuthMetadata.token_endpoint_auth_methods_supported = ['client_secret_post'];

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
  const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', issuerUrl).href;
  const bearerAuth = requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl });
  const mcpRateLimit = rateLimit({ windowMs: 60_000, limit: 120 });

  const sessionRuntimeConfig = getSessionRuntimeConfig();
  const sessionClientNames = new Map<string, string>();
  const pendingTransports = new Set<StreamableHTTPServerTransport>();
  const sessions = new SessionRegistry<StreamableHTTPServerTransport>({
    idleTtlMs: sessionRuntimeConfig.idleTtlMs,
    maxSessions: sessionRuntimeConfig.maxSessions,
    onRemove: (sessionId) => sessionClientNames.delete(sessionId),
    onCloseError: (error) => {
      logEvent('mcp_session_close_error', { error: serializeError(error) });
    },
  });

  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
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
      pendingTransports: pendingTransports.size,
      requests: requestMetrics.snapshot(),
      uploads: uploadRuntime.snapshot(),
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
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
    if (shuttingDown) {
      res.setHeader('Retry-After', '10');
      res.status(503).json({ error: 'MCP server is shutting down' });
      return;
    }

    let reservation: ReturnType<typeof sessions.reserve>;
    let lease: ReturnType<typeof sessions.acquire>;
    let initializedSessionId: string | undefined;
    let unregisteredTransport: StreamableHTTPServerTransport | undefined;

    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId) {
        lease = sessions.acquire(sessionId);
        if (!lease) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
        transport = lease.transport;
      } else {
        reservation = sessions.reserve();
        if (!reservation) {
          res.setHeader('Retry-After', '60');
          res.status(503).json({ error: 'MCP session capacity reached' });
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            if (!reservation) {
              throw new Error('MCP session initialized without a capacity reservation');
            }
            lease = reservation.commit(sessionId, transport);
            reservation = undefined;
            pendingTransports.delete(transport);
            unregisteredTransport = undefined;
            initializedSessionId = sessionId;
          },
        });
        pendingTransports.add(transport);
        unregisteredTransport = transport;
        transport.onclose = () => {
          pendingTransports.delete(transport);
          if (transport.sessionId) {
            void sessions.remove(transport.sessionId, 'closed', false);
          }
        };
        const sessionServer = serverFactory.createServer();
        sessionServer.server.oninitialized = () => {
          const clientVersion = sessionServer.server.getClientVersion();
          if (clientVersion?.name && transport.sessionId) {
            sessionClientNames.set(transport.sessionId, clientVersion.name);
          }
        };
        await sessionServer.connect(transport);
      }

      const clientName = transport.sessionId
        ? sessionClientNames.get(transport.sessionId)
        : undefined;
      await runWithAuth(token, clientName, () => transport.handleRequest(req, res, req.body));

      if (reservation) {
        await transport.close();
        unregisteredTransport = undefined;
      }
    } catch (error) {
      if (initializedSessionId) {
        await sessions.remove(initializedSessionId, 'closed');
      } else if (unregisteredTransport) {
        if (unregisteredTransport.sessionId) {
          sessionClientNames.delete(unregisteredTransport.sessionId);
        }
        await unregisteredTransport.close().catch((closeError) => {
          logEvent('mcp_session_close_error', { error: serializeError(closeError) });
        });
      }
      logEvent('mcp_handler_error', {
        requestId: res.locals.requestId,
        error: serializeError(error),
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
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
    toolCount: serverFactory.toolCount,
  });
  logRuntimeTelemetry();

  const shutdown = async (reason: 'SIGTERM' | 'SIGINT') => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('shutdown_started', {
      reason,
      sessions: sessions.stats(),
      pendingTransports: pendingTransports.size,
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
    await Promise.allSettled([...pendingTransports].map((transport) => transport.close()));
    pendingTransports.clear();
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
