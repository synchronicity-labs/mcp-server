import { AsyncLocalStorage } from 'node:async_hooks';

type RequestAuthContext = {
  token: string;
  clientName?: string;
};

const authContext = new AsyncLocalStorage<RequestAuthContext>();

export function runWithAuth<T>(token: string, clientName: string | undefined, fn: () => T): T {
  return authContext.run({ token, clientName }, fn);
}

export function getAuthToken(): string | undefined {
  return authContext.getStore()?.token;
}

export function getClientName(): string | undefined {
  return authContext.getStore()?.clientName;
}
