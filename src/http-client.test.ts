import { describe, expect, it } from 'vitest';
import { resolveSyncSource } from './http-client.js';

describe('resolveSyncSource', () => {
  it('maps flagship assistant clients to first-class sources', () => {
    expect(resolveSyncSource('chatgpt')).toBe('chatgpt');
    expect(resolveSyncSource('ChatGPT')).toBe('chatgpt');
    expect(resolveSyncSource('openai')).toBe('chatgpt');
    expect(resolveSyncSource('claude')).toBe('claude');
    expect(resolveSyncSource('Claude')).toBe('claude');
    expect(resolveSyncSource('gemini')).toBe('gemini');
  });

  it('namespaces every other MCP client under mcp:<client>', () => {
    expect(resolveSyncSource('cursor')).toBe('mcp:cursor');
    expect(resolveSyncSource('zed')).toBe('mcp:zed');
  });

  it('falls back to bare mcp when no client name is known', () => {
    expect(resolveSyncSource(undefined)).toBe('mcp');
  });
});
