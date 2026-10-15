import { expect, it } from 'vitest';
import { oauthFailureDiagnostics, oauthRequestDiagnostics } from './oauth-diagnostics.js';

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

it.each([
  [undefined, 'missing'],
  ['', 'empty'],
  ['private credential', 'present'],
  [['private credential'], 'non_string'],
  [null, 'non_string'],
])('classifies credential presence without retaining values: %j', (value, state) => {
  expect(oauthRequestDiagnostics({ client_id: value, client_secret: value }, undefined)).toEqual({
    bodyClientId: state,
    bodyClientSecret: state,
    authorizationScheme: 'none',
  });
});

it.each([
  ['Basic private credential', 'basic'],
  ['bAsIc private credential', 'basic'],
  ['Basic', 'basic'],
  ['Bearer private credential', 'other'],
  ['private credential', 'other'],
  ['', 'other'],
])('labels the supplied authorization scheme without logging it: %j', (header, scheme) => {
  const diagnostics = oauthRequestDiagnostics({ refresh_token: 'private credential' }, header);
  expect(diagnostics).toEqual({
    bodyClientId: 'missing',
    bodyClientSecret: 'missing',
    authorizationScheme: scheme,
  });
  expect(JSON.stringify(diagnostics)).not.toContain('private credential');
});

it('distinguishes organization access loss from an invalid refresh token', () => {
  expect(
    oauthFailureDiagnostics({
      error: 'invalid_grant',
      message: 'Account no longer has access to this organization',
    }),
  ).toEqual({ oauthError: 'invalid_grant', reason: 'organization_access_revoked' });
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
