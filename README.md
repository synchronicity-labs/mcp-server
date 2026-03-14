# Sync MCP Server

An open-source [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for the [Sync](https://sync.so) API. Gives AI agents — Claude Code, ChatGPT, Cursor, Codex, and any MCP-compatible client — the ability to create lipsync videos, manage assets, check generation status, and more.

Tools are **auto-generated from the Sync OpenAPI spec** at startup. As new API endpoints ship, they become available to agents automatically — no server update needed.

## Quick Start

### Claude Code / Claude Desktop

Add to your MCP config (`.mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sync": {
      "command": "npx",
      "args": ["-y", "@sync.so/mcp-server"],
      "env": {
        "SYNC_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "sync": {
      "command": "npx",
      "args": ["-y", "@sync.so/mcp-server"],
      "env": {
        "SYNC_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Without an API key (interactive login)

Omit `SYNC_API_KEY` and the server will start a device auth flow on first run:

```json
{
  "mcpServers": {
    "sync": {
      "command": "npx",
      "args": ["-y", "@sync.so/mcp-server"]
    }
  }
}
```

You'll be prompted to visit a URL and enter a code. After approval, the token is cached at `~/.config/sync/mcp-credentials.json`.

## Getting an API Key

1. Sign up at [sync.so](https://sync.so)
2. Go to your dashboard settings
3. Generate an API key

See the [authentication guide](https://sync.so/docs/api-reference/guides/authentication) for details.

## Available Tools

Tools are dynamically generated from the Sync API. Core tools include:

| Tool | Description |
|------|-------------|
| `generate_create-generation` | Create a lipsync video from video + audio inputs |
| `generate_get-generation` | Get generation status — poll until COMPLETED |
| `models_get-public` | List available lipsync models |
| `assets_get-all` | List all assets in your organization |
| `assets_get` | Get a specific asset by ID |
| `generations_estimate` | Estimate generation cost before creating |

Plus every other public endpoint in the [Sync API](https://sync.so/docs/api-reference).

## Example Prompts

Once configured, ask your AI agent:

- *"List available Sync models"*
- *"Create a lipsync video with this video URL and audio URL using the lipsync-2 model"*
- *"Check the status of generation gen-abc123"*
- *"Show me my recent generations"*
- *"How much would it cost to generate a 30-second video?"*

## CLI Options

```
Usage: sync-mcp [options]

Options:
  --api-key <key>     API key (or set SYNC_API_KEY env var)
  --base-url <url>    API base URL (default: https://api.sync.so)
  --transport <type>  stdio (default) or http
  --port <port>       HTTP port (default: 3002, only with --transport http)
  -h, --help          Show this help message
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SYNC_API_KEY` | Your Sync API key | — |
| `SYNC_BASE_URL` | API base URL | `https://api.sync.so` |

## How It Works

1. On startup, the server fetches the OpenAPI spec from `{baseUrl}/api-json`
2. Parses all public endpoints into operation definitions
3. Converts each operation into an MCP tool with a Zod input schema
4. Registers tools on the MCP server
5. Each tool call makes an authenticated HTTP request to the Sync API

This means **new API endpoints are automatically available** — just restart the MCP server.

## Programmatic Usage

You can also use the server as a library:

```typescript
import { createSyncMcpServer, resolveConfig } from '@sync.so/mcp-server';

const config = resolveConfig({ apiKey: 'your-key' });
const server = await createSyncMcpServer(config);
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint

# Type check
npm run typecheck
```

## Learn More

- [Sync Documentation](https://sync.so/docs) — Full API reference and guides
- [Sync API Reference](https://sync.so/docs/api-reference) — Endpoint documentation
- [MCP Protocol](https://modelcontextprotocol.io) — Learn about the Model Context Protocol
- [Sync Website](https://sync.so) — Sign up and get started

## License

MIT
