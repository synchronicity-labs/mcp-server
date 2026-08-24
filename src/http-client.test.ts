import { afterEach, describe, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import { getEffectiveClientName, resolveSyncSource, setStaticClientName } from './http-client.js';

afterEach(() => {
  setStaticClientName(undefined);
});

describe('getEffectiveClientName', () => {
  it('uses the stdio client identity when there is no request context', () => {
    setStaticClientName('claude');

    expect(getEffectiveClientName()).toBe('claude');
  });

  it('prefers the request-scoped HTTP client identity', () => {
    setStaticClientName('claude');

    expect(runWithAuth('token', 'chatgpt', () => getEffectiveClientName())).toBe('chatgpt');
  });
});

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
