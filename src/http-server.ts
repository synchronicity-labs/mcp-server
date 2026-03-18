import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { runWithAuth } from './auth/async-context.js';
import { createOAuthProvider } from './auth/oauth-provider.js';
import type { SyncMcpConfig } from './config.js';

export async function startHttpServer(server: McpServer, config: SyncMcpConfig): Promise<void> {
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
        // New session — create a transport and connect the server
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };
        await server.connect(transport);
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

  app.listen(config.port, () => {
    log(`Sync MCP server listening on http://localhost:${config.port}\n`);
    log(`OAuth issuer: ${issuerUrl.toString()}\n`);
    log(`API base URL: ${config.baseUrl}\n`);
  });
}
