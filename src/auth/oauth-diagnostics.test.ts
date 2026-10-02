import { expect, it } from 'vitest';
import { oauthFailureDiagnostics } from './oauth-diagnostics.js';

it.each([
  { error: 'invalid_grant', error_description: 'private token' },
  { error: 'private token', message: 'private token', access_token: 'private token' },
  { error: ['private token'], message: ['private token'] },
  { error: 'invalid_grant', message: 'Invalid, revoked, or expired refresh token: private token' },
  '<html>private token</html>',
  null,
])('does not log arbitrary upstream values: %j', (response) => {
  expect(JSON.stringify(oauthFailureDiagnostics(response))).not.toContain('private token');
});

it('recognizes only exact OAuth errors and Sync reasons', () => {
  expect(oauthFailureDiagnostics(JSON.stringify({ error: 'invalid_grant' }))).toEqual({
    oauthError: 'invalid_grant',
    reason: 'unrecognized_response',
  });
  expect(oauthFailureDiagnostics({ message: 'Unknown client_id' })).toEqual({
    oauthError: 'unknown',
    reason: 'unknown_client',
  });
});
