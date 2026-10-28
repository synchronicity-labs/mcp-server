export function resourceMetadataUrl(port: number): string {
  return new URL(
    '/.well-known/oauth-protected-resource/mcp',
    process.env.MCP_ISSUER_URL || `http://localhost:${port}`,
  ).href;
}
