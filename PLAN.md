# MCP Server Roadmap

## Phase 1: Local MCP Server (stdio) — DONE

Local stdio-based MCP server that works with desktop AI clients.

### Supported Clients

| Client | Transport | Status |
|--------|-----------|--------|
| Claude Desktop | stdio | Supported |
| ChatGPT Desktop | stdio | Not yet supported |
| Claude Code (CLI) | stdio | Supported |
| Cursor | stdio | Supported |
| Windsurf | stdio | Supported |
| Codex CLI | stdio | Supported |
| Any MCP-compatible client | stdio | Supported |

### What shipped
- Auto-generated tools from OpenAPI spec
- API key + device auth flow
- HTTP transport mode (`--transport http`)
- Published to npm as `@sync.so/mcp-server`

---

## Phase 2: Remote MCP Server (HTTP + OAuth) — NEXT

Deploy as a hosted HTTP endpoint so users can connect from Claude Web, ChatGPT Web, and other browser-based clients without installing anything locally.

### New Clients Unlocked

| Client | Transport | Status |
|--------|-----------|--------|
| Claude Web (claude.ai) | Remote HTTP | Custom connector (any Pro/Max/Team/Enterprise user can add) |
| ChatGPT Web | GPT Actions (OpenAPI) | Separate integration — uses existing OpenAPI spec |

### Technical Work

1. **OAuth 2.0 Authorization Code Flow**
   - Implement OAuth provider endpoints (`/authorize`, `/token`, `/callback`)
   - Allowlist Anthropic callback URLs:
     - `https://claude.ai/api/mcp/auth_callback`
     - `https://claude.com/api/mcp/auth_callback`
     - `http://localhost:6274/oauth/callback` (Claude Code)
   - Token refresh + expiry handling
   - Map OAuth tokens to Sync API keys

2. **Tool Annotations**
   - Add `readOnlyHint: true` or `destructiveHint: true` to every tool
   - Add `title` field for UI display
   - This is the #1 rejection reason for Anthropic directory submissions

3. **Hosting**
   - Deploy as HTTP server (Cloudflare Workers, Fly.io, or similar)
   - Streamable HTTP transport (already supported via `--transport http`)
   - HTTPS/TLS with valid certificates
   - CORS configuration

4. **Testing**
   - Test as custom connector on claude.ai (no directory approval needed)
   - Verify OAuth flow end-to-end

### Effort Estimate
- With existing OAuth: ~1-2 weeks
- Without existing OAuth: ~2-3 weeks

---

## Phase 3: Anthropic Directory Listing — LATER

Get listed in Anthropic's official MCP integrations directory for discoverability.

### Requirements
- Server must be GA (not beta)
- Published documentation with minimum 3 usage examples
- Privacy policy URL
- Data processing agreement URL
- Support channel (email or web)
- Test account with sample data for Anthropic's review team

### Submission
- Google Form: https://docs.google.com/forms/d/e/1FAIpQLSeafJF2NDI7oYx1r8o0ycivCSVLNq92Mpc1FPxMKSw1CzDkqA/viewform
- No SLA on review time ("overwhelming interest")

### References
- [Remote MCP Server Submission Guide](https://support.claude.com/en/articles/12922490-remote-mcp-server-submission-guide)
- [Anthropic Connectors Directory FAQ](https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq)
- [MCP Directory Policy](https://support.claude.com/en/articles/11697096-anthropic-mcp-directory-policy)
- [Building Custom Integrations](https://support.claude.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers)
