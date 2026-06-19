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
    const fetchMock = vi.fn(async () => ({
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
      token_endpoint_auth_method: 'none',
    });
  });

  it('returns complete metadata for newly registered public clients', async () => {
    const fetchMock = vi.fn(async () => ({
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
    const registered = await provider.clientsStore.registerClient?.({
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });

    expect(registered).toMatchObject({
      client_id: 'client-123',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
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
