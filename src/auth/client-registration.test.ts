import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  MAX_CLIENT_NAME_LENGTH,
  namesOnlyHostedAgentCallbacks,
  redirectUriProblem,
  restrictRegistration,
  sanitizeClientName,
} from './client-registration.js';

// Callbacks real clients register with today (Cursor sends all three of its own).
const KNOWN_CLIENT_CALLBACKS = {
  'Claude (claude.ai)': ['https://claude.ai/api/mcp/auth_callback'],
  'Claude (claude.com)': ['https://claude.com/api/mcp/auth_callback'],
  'ChatGPT connector': ['https://chatgpt.com/connector_platform_oauth_redirect'],
  'ChatGPT app': ['https://chatgpt.com/connector/oauth/SMmdXG4Cq5no'],
  'Claude Code': ['http://localhost:54321/callback'],
  Codex: ['http://127.0.0.1:1455/auth/callback'],
  'Gemini CLI': ['http://localhost:7777/oauth/callback'],
  'sync. CLI': ['http://127.0.0.1/callback'],
  Cursor: [
    'cursor://anysphere.cursor-mcp/oauth/callback',
    'https://www.cursor.com/agents/mcp/oauth/callback',
    'http://localhost:8787/callback',
  ],
  'VS Code': [
    'https://insiders.vscode.dev/redirect',
    'https://vscode.dev/redirect',
    'http://127.0.0.1/',
    'http://127.0.0.1:33418/',
  ],
  'VS Code extension': ['vscode://saoudrizwan.claude-dev/mcp-auth/callback'],
  'IPv6 loopback': ['http://[::1]:8080/callback'],
  'MCP Inspector': ['http://localhost:6274/oauth/callback'],
};

function client(metadata: Partial<OAuthClientInformationFull>): OAuthClientInformationFull {
  return { client_id: 'generated', redirect_uris: ['https://app.example/cb'], ...metadata };
}

describe('redirect URIs', () => {
  it.each(Object.entries(KNOWN_CLIENT_CALLBACKS))('accepts %s', (_name, uris) => {
    expect(restrictRegistration(client({ redirect_uris: uris })).redirect_uris).toEqual(uris);
  });

  it.each([
    ['http://evil.example/cb', 'must use https'],
    ['http://localhost.evil.example/cb', 'must use https'],
    ['http://127.0.0.2/cb', 'must use https'],
    ['https://user:pass@app.example/cb', 'user information'],
    ['https://user@app.example/cb', 'user information'],
    ['https://app.example/cb#frag', 'fragment'],
    ['https://app.example/cb#', 'fragment'],
    ['file:///etc/passwd', 'scheme'],
    ['intent://scan/#Intent;scheme=zxing;end', 'fragment'],
    ['ms-word:ofe|u|https://app.example/x', 'scheme'],
    ['myapp://callback', 'scheme'],
    ['not a url', 'not a valid URL'],
    [`https://app.example/${'a'.repeat(2_100)}`, 'too long'],
  ])('refuses %s', (uri, problem) => {
    expect(redirectUriProblem(uri)).toContain(problem);
    expect(() => restrictRegistration(client({ redirect_uris: [uri] }))).toThrow(problem);
  });

  it('refuses the whole registration when any callback is refused', () => {
    expect(() =>
      restrictRegistration(
        client({ redirect_uris: ['https://app.example/cb', 'http://evil.example/cb'] }),
      ),
    ).toThrow(expect.objectContaining({ errorCode: 'invalid_redirect_uri' }));
  });

  it('caps the number of callbacks', () => {
    const uris = Array.from({ length: 21 }, (_, i) => `https://app.example/${i}`);
    expect(() => restrictRegistration(client({ redirect_uris: uris }))).toThrow('At most 20');
  });
});

describe('grant types and other metadata', () => {
  it('keeps only the grants the API issues', () => {
    const restricted = restrictRegistration(
      client({
        grant_types: ['authorization_code', 'refresh_token', 'client_credentials', 'implicit'],
      }),
    );
    expect(restricted.grant_types).toEqual(['authorization_code', 'refresh_token']);
  });

  it('leaves grants unset when the client sends none, so the API default applies', () => {
    expect(restrictRegistration(client({}))).not.toHaveProperty('grant_types');
  });

  it('refuses a client that cannot use the authorization code grant', () => {
    expect(() => restrictRegistration(client({ grant_types: ['client_credentials'] }))).toThrow(
      expect.objectContaining({ errorCode: 'invalid_client_metadata' }),
    );
    expect(() => restrictRegistration(client({ response_types: ['token'] }))).toThrow(
      'response_types',
    );
  });

  it('forwards only the fields the API uses', () => {
    const restricted = restrictRegistration(
      client({
        client_name: 'Cursor',
        token_endpoint_auth_method: 'none',
        logo_uri: 'https://evil.example/logo.png',
        client_uri: 'https://evil.example',
        scope: 'admin everything',
        contacts: ['a@evil.example'],
        tos_uri: 'https://evil.example/tos',
        policy_uri: 'https://evil.example/policy',
        software_statement: 'jwt',
        client_secret: 'sdk-generated',
      }),
    );
    expect(restricted).toEqual({
      client_id: 'generated',
      client_name: 'Cursor',
      redirect_uris: ['https://app.example/cb'],
      token_endpoint_auth_method: 'none',
    });
  });
});

describe('client names', () => {
  it('keeps ordinary names as they are', () => {
    expect(sanitizeClientName('Claude Code (sync)')).toBe('Claude Code (sync)');
    expect(sanitizeClientName('Gemini CLI MCP Client')).toBe('Gemini CLI MCP Client');
  });

  it('removes hidden characters and collapses whitespace', () => {
    expect(sanitizeClientName('Clau‮de​ \n\t App\u0000')).toBe('Claude App');
  });

  it('caps the length', () => {
    expect(sanitizeClientName('x'.repeat(500))).toHaveLength(MAX_CLIENT_NAME_LENGTH);
    expect(Array.from(sanitizeClientName('🎬'.repeat(500)) ?? '')).toHaveLength(
      MAX_CLIENT_NAME_LENGTH,
    );
  });

  it('drops a name with nothing visible in it', () => {
    expect(sanitizeClientName('​ ‮')).toBeUndefined();
    expect(restrictRegistration(client({ client_name: '  ' }))).not.toHaveProperty('client_name');
  });
});

describe('hosted agent callbacks', () => {
  it('recognizes registrations naming only hosted Claude and ChatGPT callbacks', () => {
    expect(namesOnlyHostedAgentCallbacks(['https://claude.ai/api/mcp/auth_callback'])).toBe(true);
    expect(
      namesOnlyHostedAgentCallbacks([
        'https://chatgpt.com/connector/oauth/SMmdXG4Cq5no',
        'https://chatgpt.com/connector_platform_oauth_redirect',
      ]),
    ).toBe(true);
  });

  it.each([
    [['https://claude.ai/api/mcp/auth_callback', 'https://evil.example/cb']],
    [['https://claude.ai/api/mcp/auth_callback/extra']],
    [['https://chatgpt.com/connector/oauth/x/../../evil']],
    [[]],
    ['https://claude.ai/api/mcp/auth_callback'],
    [undefined],
  ])('treats %j as any other registration', (uris) => {
    expect(namesOnlyHostedAgentCallbacks(uris)).toBe(false);
  });
});
