export type ApiKeyAuth = {
  type: 'api-key';
  headers: Record<string, string>;
};

export function createApiKeyAuth(apiKey: string): ApiKeyAuth {
  return {
    type: 'api-key',
    headers: { 'x-api-key': apiKey },
  };
}
