// Diagnostics must never copy upstream text: OAuth errors can echo credentials.
// Only exact, known values are converted to fixed labels.
const OAUTH_ERRORS = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  'server_error',
  'temporarily_unavailable',
]);

const KNOWN_REASONS = new Map([
  ['Invalid, revoked, or expired refresh token', 'refresh_token_invalid_revoked_or_expired'],
  ['Refresh token not found', 'refresh_token_not_found'],
  ['refresh_token and client_id are required', 'missing_refresh_parameters'],
  ['Unknown client_id', 'unknown_client'],
  ['Invalid client_secret', 'invalid_client_secret'],
  ['client_secret is required', 'missing_client_secret'],
  ['Invalid or expired authorization code', 'authorization_code_invalid_or_expired'],
  ['code, client_id, and redirect_uri are required', 'missing_code_parameters'],
  ['client_id mismatch', 'client_id_mismatch'],
  ['redirect_uri mismatch', 'redirect_uri_mismatch'],
  ['code_verifier required for PKCE challenge', 'missing_pkce_verifier'],
  ['PKCE code_verifier mismatch', 'pkce_verifier_mismatch'],
  ['Multiple Authorization headers are not allowed', 'duplicate_authorization_headers'],
  ['OAuth parameters must be single strings', 'non_scalar_oauth_parameters'],
  ['Multiple client authentication methods are not allowed', 'mixed_client_authentication'],
  ['Unsupported client authentication method', 'unsupported_client_authentication'],
  ['Client credentials must be single strings', 'non_scalar_client_credentials'],
  ['Invalid client authentication', 'invalid_client_authentication'],
]);

export function oauthFailureDiagnostics(response: unknown): {
  oauthError: string;
  reason: string;
} {
  let value = response;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { oauthError: 'unknown', reason: 'unrecognized_response' };
    }
  }
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const reason = [body.message, body.error_description]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => KNOWN_REASONS.get(value))
    .find((value) => value !== undefined);
  return {
    oauthError:
      typeof body.error === 'string' && OAUTH_ERRORS.has(body.error) ? body.error : 'unknown',
    reason: reason ?? 'unrecognized_response',
  };
}

export function oauthGrantType(value: unknown): string {
  if (value === 'authorization_code' || value === 'refresh_token') return value;
  return value === undefined ? 'missing' : 'other';
}
