import { AsyncLocalStorage } from 'node:async_hooks';

type RequestAuthContext = {
  token: string;
  clientName?: string;
  // Verified user, OAuth client and organization; unlike the token, it survives refresh.
  owner?: string;
};

const authContext = new AsyncLocalStorage<RequestAuthContext>();

export function runWithAuth<T>(
  token: string,
  clientName: string | undefined,
  fn: () => T,
  owner?: string,
): T {
  return authContext.run({ token, clientName, owner }, fn);
}

export function getAuthToken(): string | undefined {
  return authContext.getStore()?.token;
}

export function getAuthOwner(): string | undefined {
  return authContext.getStore()?.owner;
}

export function getClientName(): string | undefined {
  return authContext.getStore()?.clientName;
}
