import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOAuthProvider } from './oauth-provider.js';

const API = 'https://api.sync.so';

describe('createOAuthProvider — getClient', () => {
  beforeEach(() => {
    process.env.OAUTH_REGISTRATION_SECRET = 'reg-secret';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.OAUTH_REGISTRATION_SECRET = undefined;
  });

  it('reads a client back from the API on a cold cache (survives restarts)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        client_id: 'client-123',
        client_name: 'ChatGPT',
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        grant_types: ['authorization_code', 'refresh_token'],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOAuthProvider(API);
    const client = await provider.clientsStore.getClient('client-123');

    // Hit the RFC 7592 read endpoint with the registration secret.
    expect(fetchMock).toHaveBeenCalledWith(
      `${API}/v2/oauth/register/client-123`,
      expect.objectContaining({ headers: { Authorization: 'Bearer reg-secret' } }),
    );
    expect(client).toMatchObject({
      client_id: 'client-123',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    });
  });

  it('returns complete metadata for newly registered confidential clients', async () => {
    let registrationBody: unknown;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => {
        registrationBody = JSON.parse(
          typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body),
        );
        return {
          client_id: 'client-123',
          client_secret: 'client-secret',
          client_name: 'ChatGPT',
          redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
          grant_types: ['authorization_code', 'refresh_token'],
        };
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOAuthProvider(API);
    const registered = await provider.clientsStore.registerClient?.({
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });

    expect(registered).toMatchObject({
      client_id: 'client-123',
      client_secret: 'client-secret',
      client_secret_expires_at: 0,
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    });
    expect(registrationBody).toMatchObject({
      token_endpoint_auth_method: 'client_secret_post',
    });
  });

  it('caches the API result so a second lookup makes no further request', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        client_id: 'client-123',
        redirect_uris: ['https://x/cb'],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOAuthProvider(API);
    await provider.clientsStore.getClient('client-123');
    await provider.clientsStore.getClient('client-123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for an unknown client (404)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    const provider = createOAuthProvider(API);
    expect(await provider.clientsStore.getClient('nope')).toBeUndefined();
  });
});

describe('createOAuthProvider — public clients', () => {
  beforeEach(() => {
    process.env.OAUTH_REGISTRATION_SECRET = 'reg-secret';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.OAUTH_REGISTRATION_SECRET = undefined;
  });

  // The registration body sent to the API, and the API's reply.
  function registerWith(reply: Record<string, unknown>) {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
        return { ok: true, json: async () => ({ client_id: 'client-123', ...reply }) };
      }),
    );
    return { bodies, provider: createOAuthProvider(API) };
  }

  const geminiCli = {
    client_name: 'Gemini CLI MCP Client',
    redirect_uris: ['http://localhost:7777/oauth/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };

  it('registers a client that asks for none as public', async () => {
    const { bodies, provider } = registerWith({
      redirect_uris: geminiCli.redirect_uris,
      token_endpoint_auth_method: 'none',
    });
    const registered = await provider.clientsStore.registerClient?.(geminiCli);

    expect(bodies[0]).toMatchObject({ token_endpoint_auth_method: 'none' });
    expect(registered).toMatchObject({ token_endpoint_auth_method: 'none' });
    expect(registered).not.toHaveProperty('client_secret');
    expect(registered).not.toHaveProperty('client_secret_expires_at');
  });

  it('keeps a client confidential when the API still gives it a secret', async () => {
    const { provider } = registerWith({
      client_secret: 'client-secret',
      redirect_uris: geminiCli.redirect_uris,
    });
    const registered = await provider.clientsStore.registerClient?.(geminiCli);

    expect(registered).toMatchObject({
      client_secret: 'client-secret',
      token_endpoint_auth_method: 'client_secret_post',
    });
  });

  it('keeps the Claude app confidential though it asks for none', async () => {
    const { bodies, provider } = registerWith({
      client_secret: 'client-secret',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    await provider.clientsStore.registerClient?.({
      ...geminiCli,
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });

    expect(bodies[0]).toMatchObject({ token_endpoint_auth_method: 'client_secret_post' });
  });

  it('reads a public client back as public after a restart', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          client_id: 'client-123',
          redirect_uris: geminiCli.redirect_uris,
          token_endpoint_auth_method: 'none',
        }),
      })),
    );
    const client = await createOAuthProvider(API).clientsStore.getClient('client-123');

    expect(client).toMatchObject({ token_endpoint_auth_method: 'none' });
  });
});
