import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
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

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);

  // JSON body parsing for MCP requests
  app.use('/mcp', express.json());

  app.all('/mcp', mcpRateLimit, bearerAuth, async (req, res) => {
    const token = req.auth?.token;
    if (!token) {
      res.status(401).json({ error: 'Missing auth token' });
      return;
    }

    await runWithAuth(token, () => transport.handleRequest(req, res, req.body));
  });

  app.listen(config.port, () => {
    log(`Sync MCP server listening on http://localhost:${config.port}\n`);
    log(`OAuth issuer: ${issuerUrl.toString()}\n`);
    log(`API base URL: ${config.baseUrl}\n`);
  });
}
