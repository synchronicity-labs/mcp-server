import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { runWithAuth } from './auth/async-context.js';
import { createOAuthProvider } from './auth/oauth-provider.js';
import type { SyncMcpConfig } from './config.js';

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

  // CORS for Claude Web and other browser-based clients
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

  // Health check (unauthenticated)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
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

  // OAuth auth router — handles /.well-known/*, /authorize, /token, /register, /revoke
  const mcpEndpointUrl = new URL('/mcp', issuerUrl);
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      resourceServerUrl: mcpEndpointUrl,
      serviceDocumentationUrl: new URL('https://sync.so/docs'),
    }),
  );

  // Protected resource metadata for SSE endpoint (ChatGPT discovers OAuth via this)
  app.get('/.well-known/oauth-protected-resource/sse', (_req, res) => {
    res.json({
      resource: new URL('/sse', issuerUrl).href,
      authorization_servers: [issuerUrl.href],
      resource_documentation: 'https://sync.so/docs',
    });
  });

  // MCP endpoint — requires valid Bearer token, rate limited
  const bearerAuth = requireBearerAuth({ verifier: oauthProvider });
  const mcpRateLimit = rateLimit({ windowMs: 60_000, limit: 120 });

  // Per-session transports: MCP protocol requires stateful sessions since
  // initialize and tools/list are separate requests on the same session.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  // JSON body parsing for MCP requests
  app.use('/mcp', express.json());

  app.all('/mcp', mcpRateLimit, bearerAuth, async (req, res) => {
    const token = req.auth?.token;
    if (!token) {
      res.status(401).json({ error: 'Missing auth token' });
      return;
    }

    try {
      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId)!;
      } else if (!sessionId) {
        // New session — create a fresh server + transport pair
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };
        const sessionServer = serverFactory.createServer();
        await sessionServer.connect(transport);
      } else {
        // Unknown session ID
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      await runWithAuth(token, () => transport.handleRequest(req, res, req.body));

      // Store session after first handleRequest (sessionId is set by the transport)
      if (transport.sessionId && !sessions.has(transport.sessionId)) {
        sessions.set(transport.sessionId, transport);
      }
    } catch (error) {
      log(`MCP handler error: ${error instanceof Error ? error.stack : error}\n`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // SSE transport — for ChatGPT Web and other SSE-based MCP clients
  // GET /sse establishes the SSE stream, POST /messages sends client messages
  // ---------------------------------------------------------------------------
  const sseSessions = new Map<string, SSEServerTransport>();

  app.get('/sse', mcpRateLimit, bearerAuth, async (req, res) => {
    const token = req.auth?.token;
    if (!token) {
      res.status(401).json({ error: 'Missing auth token' });
      return;
    }

    const transport = new SSEServerTransport('/messages', res);
    sseSessions.set(transport.sessionId, transport);

    transport.onclose = () => {
      sseSessions.delete(transport.sessionId);
    };

    const sessionServer = serverFactory.createServer();
    await runWithAuth(token, () => sessionServer.connect(transport));
  });

  app.post('/messages', express.json(), mcpRateLimit, bearerAuth, async (req, res) => {
    const token = req.auth?.token;
    if (!token) {
      res.status(401).json({ error: 'Missing auth token' });
      return;
    }

    const sessionId = req.query.sessionId as string;
    const transport = sseSessions.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    await runWithAuth(token, () => transport.handlePostMessage(req, res, req.body));
  });

  app.listen(config.port, () => {
    log(`Sync MCP server listening on http://localhost:${config.port}\n`);
    log(`OAuth issuer: ${issuerUrl.toString()}\n`);
    log(`API base URL: ${config.baseUrl}\n`);
  });
}
