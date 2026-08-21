import { randomUUID } from 'node:crypto';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
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
import { createOAuthProvider } from './auth/oauth-provider.js';
import type { SyncMcpConfig } from './config.js';
import { SessionRegistry } from './session-registry.js';

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

type SessionRuntimeConfig = {
  idleTtlMs: number;
  maxSessions: number;
  sweepIntervalMs: number;
  shutdownGraceMs: number;
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
  };
}

export async function runSessionSweepSafely(
  sessions: { sweep: () => Promise<unknown> },
  logTelemetry: () => void,
  log: (message: string) => void,
): Promise<void> {
  try {
    await sessions.sweep();
  } catch (error) {
    log(`MCP session sweep error: ${error instanceof Error ? error.stack : error}\n`);
  } finally {
    logTelemetry();
  }
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

  // Request logging
  app.use((req, res, next) => {
    res.on('finish', () => {
      log(`${req.method} ${req.url.split('?')[0]} → ${res.statusCode}\n`);
    });
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
      log(`OAuth ${path} proxy error: ${error instanceof Error ? error.stack : error}\n`);
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
      log(`MCP session close error: ${error instanceof Error ? error.stack : error}\n`);
    },
  });

  const logRuntimeTelemetry = () => {
    const memory = process.memoryUsage();
    log(
      `${JSON.stringify({
        event: 'mcp_runtime',
        pod: process.env.HOSTNAME,
        uptimeSeconds: Math.round(process.uptime()),
        sessions: sessions.stats(),
        memory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
        },
      })}\n`,
    );
  };

  let sweepRunning = false;
  const sessionSweepInterval = setInterval(() => {
    if (sweepRunning) return;
    sweepRunning = true;
    void runSessionSweepSafely(sessions, logRuntimeTelemetry, log).finally(() => {
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
          log(
            `MCP session close error: ${closeError instanceof Error ? closeError.stack : closeError}\n`,
          );
        });
      }
      log(`MCP handler error: ${error instanceof Error ? error.stack : error}\n`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    } finally {
      lease?.release();
      reservation?.release();
    }
  });

  const httpServer = app.listen(config.port, () => {
    log(`Sync MCP server listening on http://localhost:${config.port}\n`);
    log(`OAuth issuer: ${issuerUrl.toString()}\n`);
    log(`API base URL: ${config.baseUrl}\n`);
    log(
      `MCP session limits: ttl=${sessionRuntimeConfig.idleTtlMs}ms max=${sessionRuntimeConfig.maxSessions}\n`,
    );
    logRuntimeTelemetry();
  });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sessionSweepInterval);

    // Stop admission first, then let requests and initializations already in progress drain.
    httpServer.close();
    httpServer.closeIdleConnections();
    const deadline = Date.now() + sessionRuntimeConfig.shutdownGraceMs;
    let runtimeStats = sessions.stats();
    while ((runtimeStats.pending > 0 || runtimeStats.inFlight > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      runtimeStats = sessions.stats();
    }
    if (runtimeStats.pending > 0 || runtimeStats.inFlight > 0) {
      log(
        `MCP shutdown grace expired: pending=${runtimeStats.pending} inFlight=${runtimeStats.inFlight}\n`,
      );
    }

    // Freeze reservations before taking final snapshots so late initialization cannot escape cleanup.
    sessions.stopAccepting();
    await Promise.allSettled([...pendingTransports].map((transport) => transport.close()));
    pendingTransports.clear();
    await sessions.closeAll();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
