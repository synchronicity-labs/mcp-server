#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveConfig } from './config.js';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = resolveConfig(parseArgs(args));

  if (config.transport === 'stdio') {
    const server = await createSyncMcpServer(config);
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
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return result;
}

function printUsage(): void {
  process.stderr.write(`Usage: sync-mcp [options]

Options:
  --api-key <key>     API key (or set SYNC_API_KEY env var)
  --base-url <url>    API base URL (default: https://api.sync.so)
  --transport <type>  stdio (default) or http
  --port <port>       HTTP port (default: 3002, only with --transport http)
  -h, --help          Show this help message
`);
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
