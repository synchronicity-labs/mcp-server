#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { resolveConfig } from './config.js';
import { runLogin } from './login-command.js';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';
import { parseToolsets, type Toolset } from './toolsets.js';
import { startConfiguredUpdateCheck } from './update-check.js';
import { PACKAGE_VERSION } from './version.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = resolveConfig(parseArgs(args));

  if (args[0] === 'login') {
    process.exitCode = await runLogin(args.slice(1), config.baseUrl);
    return;
  }

  if (config.transport === 'stdio') {
    // Started before auth and the spec fetch, and never awaited.
    const updateCheck = startConfiguredUpdateCheck(config, PACKAGE_VERSION);
    const server = await createSyncMcpServer(config, { updateCheck });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else {
    // HTTP transport: each session gets its own McpServer instance
    const factory = await createMcpServerFactory(config);
    const { startHttpServer } = await import('./http-server.js');
    await startHttpServer(factory, config);
  }
}

function parseArgs(args: string[]): Partial<{
  apiKey: string;
  baseUrl: string;
  transport: 'stdio' | 'http';
  port: number;
  spendConfirmation: boolean;
  updateCheck: boolean;
  telemetry: boolean;
  toolsets: Toolset[];
}> {
  const result: Record<string, unknown> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--api-key' && next) {
      result.apiKey = next;
      i++;
    } else if (arg === '--base-url' && next) {
      result.baseUrl = next;
      i++;
    } else if (arg === '--transport' && next) {
      result.transport = next;
      i++;
    } else if (arg === '--port' && next) {
      result.port = Number.parseInt(next, 10);
      i++;
    } else if (arg === '--no-spend-confirmation') {
      result.spendConfirmation = false;
    } else if (arg === '--no-update-check') {
      result.updateCheck = false;
    } else if (arg === '--no-telemetry') {
      result.telemetry = false;
    } else if (arg === '--toolsets' && next) {
      result.toolsets = parseToolsets(next);
      i++;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return result;
}

function printUsage(): void {
  process.stderr.write(`Usage: sync-mcp [options]
       sync-mcp login --email <address> [--agent <name>]
       sync-mcp login --code <code>

Commands:
  login               Sign in by a code emailed to you, with no browser. Run it with
                      --email, then again with --code and the code from the email.
                      --agent names your agent in the emails sync. sends.

Options:
  --api-key <key>     API key (or set SYNC_API_KEY env var)
  --base-url <url>    API base URL (default: https://api.sync.so)
  --transport <type>  stdio (default) or http
  --port <port>       HTTP port (default: 3002, only with --transport http)
  --no-spend-confirmation
                      Unattended automation: drop the cost-quote and confirm-before-paying
                      instructions (or set SYNC_MCP_SPEND_CONFIRMATION=off)
  --no-update-check   Skip the daily npm check for a newer version (or set
                      SYNC_MCP_UPDATE_CHECK=off; skipped when CI is set)
  --no-telemetry      Send no usage events to sync. (or set SYNC_MCP_TELEMETRY=off
                      or DO_NOT_TRACK=1); see README › Usage telemetry
  --toolsets <list>   stdio only: comma-separated tools to list (or set SYNC_MCP_TOOLSETS):
                      default, lipsync, dubbing, assets, projects, transcription,
                      voices, admin or all (default: the hosted set without admin)
  -h, --help          Show this help message
`);
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
