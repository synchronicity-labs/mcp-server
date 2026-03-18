import { AsyncLocalStorage } from 'node:async_hooks';

type RequestAuthContext = {
  token: string;
};

const authContext = new AsyncLocalStorage<RequestAuthContext>();

export function runWithAuth<T>(token: string, fn: () => T): T {
  return authContext.run({ token }, fn);
}

export function getAuthToken(): string | undefined {
  return authContext.getStore()?.token;
}
