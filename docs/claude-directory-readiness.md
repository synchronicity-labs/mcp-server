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
- [x] Hide ChatGPT-only upload tools/resources/file metadata from Claude and unknown clients
- [ ] Add public privacy, support, and service documentation URLs for the listing
- [ ] Create a reviewer account with enough credits and sample media to run every tool
- [ ] Test every hosted tool through MCP Inspector and a new Claude custom connector
- [ ] Prepare the listing name, logo, short description, and support contact
- [ ] Prepare three to five screenshots only if the submitted Claude connector includes a working MCP App UI

## Upload Widget Note

The upload widget uses the ChatGPT `window.openai` bridge and is exposed only to exact known ChatGPT aliases. Claude and unknown clients use public/Sync-hosted URLs or existing asset IDs. For local media, use authenticated Sync upload → Copy ID in the same organization; Copy URL is also accepted. Direct unsupported tool/resource/file calls explain this path.

## Local validation and release dependencies (2026-09-24)

Profiles are immutable per initialized session; HTTP initialization composes the profile callback with session identity tracking. HTTP identities never use a process-global stdio fallback. Handshake names affect presentation/default projects only and do not confer authentication, organization or credit permissions. Existing source attribution is not promoted to trusted attribution.

Known aliases: `chatgpt`, `openai`, `openai-chatgpt`; `claude`, `claude-ai` (case-insensitive exact matches). Muse aliases and origins remain unverified: unknown clients use `Sync generations`, and no Meta wildcard origins or native attachment adapter have been added. Existing allowed origins and absent-Origin server-to-server access remain supported.

Local tests exercise concurrent HTTP sessions, discovery/resources, unsupported calls, all image/video × audio/script combinations via URLs and asset IDs, voice selection, explicit project overrides and exact signed results. They use fake organizations/media/API responses, not live Muse/Claude acceptance or a real Sync Copy ID/Copy URL export.

PR56 owns cancellation. Validate PR54 + PR56 together before release, forwarding request context through the session-profile wrapper as well as registered handlers. CRAFT-5991/5992 authentication fixes are included in the combined candidate from PR57 (6b5dc7ff74bd2f773f90a07e073caf274444aef2) and PR58 (7ed6104c2d8c9d354922002414a4fa18c771eba6), via OAuth integration b6baaf6a70427de2ad75184dedc0db9eaeda8716. The local bearer-auth adapter and credential/error handling are preserved; the earlier recovery blocker is resolved. CRAFT-6168 owns combined verification. Live testing requires a designated organization/account, approved fixtures and an explicit budget; deployment and real-client evidence are still pending. Do not infer directory/release acceptance from local tests.

## References

- [Anthropic pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria)
- [Anthropic connector submission guide](https://claude.com/docs/connectors/building/submission)
- [Anthropic cross-platform MCP Apps guide](https://claude.com/docs/connectors/building/mcp-apps/cross-compatibility)
- [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)
- [MCP Streamable HTTP transport requirements](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP Apps migration guide](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/migrate_from_openai_apps.md)
