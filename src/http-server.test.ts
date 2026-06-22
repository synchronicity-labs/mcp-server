import { describe, expect, it } from 'vitest';
import {
  encodeOAuthFormBody,
  extractBasicClientCredentials,
  mergeBasicClientCredentials,
} from './http-server.js';

describe('OAuth HTTP helpers', () => {
  it('extracts percent-encoded Basic client credentials', () => {
    const authorization = `Basic ${Buffer.from('client%3Aone:secret%3Atwo').toString('base64')}`;

    expect(extractBasicClientCredentials(authorization)).toEqual({
      clientId: 'client:one',
      clientSecret: 'secret:two',
    });
  });

  it('does not overwrite an explicit client_id body field', () => {
    expect(
      mergeBasicClientCredentials(
        { client_id: 'body-client' },
        `Basic ${Buffer.from('basic-client:secret').toString('base64')}`,
      ),
    ).toEqual({ client_id: 'body-client' });
  });

  it('encodes only OAuth form fields for upstream proxying', () => {
    expect(
      encodeOAuthFormBody({
        grant_type: 'refresh_token',
        client_id: 'client-123',
        client_secret: 'secret-456',
        refresh_token: 'refresh-789',
        ignored: 'nope',
      }),
    ).toBe(
      'grant_type=refresh_token&client_id=client-123&client_secret=secret-456&refresh_token=refresh-789',
    );
  });
});
