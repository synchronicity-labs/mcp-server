# Claude Directory Readiness

This checklist tracks the work needed to submit the hosted Sync MCP server to the Claude connectors directory.

Hosted endpoint: `https://mcp.sync.so/mcp`

## Ready

- [x] HTTPS Streamable HTTP transport
- [x] OAuth discovery, dynamic client registration, and PKCE support
- [x] Strict `Origin` validation for the MCP endpoint
- [x] Tool titles and behavior annotations
- [x] Short, factual tool descriptions and server instructions
- [x] Small hosted tool set for the main lipsync workflow
- [x] Client-specific default projects for ChatGPT and Claude
- [x] Public setup instructions for Claude custom connectors

## Before Submission

- [ ] Receive Anthropic's written exception for AI video generation under section 4.B of the Software Directory Policy
- [ ] Decide whether to hide the ChatGPT-only upload widget from Claude or migrate it to the MCP Apps SDK
- [ ] Add public privacy, support, and service documentation URLs for the listing
- [ ] Create a reviewer account with enough credits and sample media to run every tool
- [ ] Test every hosted tool through MCP Inspector and a new Claude custom connector
- [ ] Prepare the listing name, logo, short description, and support contact
- [ ] Prepare three to five screenshots only if the submitted Claude connector includes a working MCP App UI

## Upload Widget Note

The current upload widget uses the ChatGPT `window.openai` bridge. It is not yet a Claude MCP App. The official MCP Apps migration guide states that ChatGPT file upload and download URL APIs do not have direct MCP Apps equivalents. Do not present this widget as Claude-compatible until the file flow is redesigned or the tool is hidden for Claude clients.

## References

- [Anthropic pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria)
- [Anthropic connector submission guide](https://claude.com/docs/connectors/building/submission)
- [Anthropic cross-platform MCP Apps guide](https://claude.com/docs/connectors/building/mcp-apps/cross-compatibility)
- [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)
- [MCP Streamable HTTP transport requirements](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP Apps migration guide](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/migrate_from_openai_apps.md)
