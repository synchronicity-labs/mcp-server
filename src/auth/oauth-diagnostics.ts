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
  ['Account no longer has access to this organization', 'organization_access_revoked'],
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
    .filter((message): message is string => typeof message === 'string')
    .map((message) => KNOWN_REASONS.get(message))
    .find((known) => known !== undefined);
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

// Describe only presence and the scheme. Never decode or retain credential values.
export function oauthRequestDiagnostics(
  body: Record<string, unknown>,
  authorization: string | undefined,
) {
  const presence = (value: unknown) => {
    if (value === undefined) return 'missing';
    if (typeof value !== 'string') return 'non_string';
    return value.length === 0 ? 'empty' : 'present';
  };
  return {
    bodyClientId: presence(body.client_id),
    bodyClientSecret: presence(body.client_secret),
    authorizationScheme:
      authorization === undefined
        ? 'none'
        : /^Basic(?:\s|$)/i.test(authorization)
          ? 'basic'
          : 'other',
  };
}
