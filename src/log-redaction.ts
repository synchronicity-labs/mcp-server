import { z } from 'zod';
import { ApiRequestError } from './http-client.js';

/**
 * Why a call failed, for logs, from fixed fields only. Error messages are never
 * logged: this server's messages and the API's both embed what the caller sent
 * (quoted values, hosts, file names), and no pattern removes all of it. The API
 * keeps its own messages in BetterStack (docs/tool-failures.md).
 */
export function errorFields(error: unknown): {
  errorName: string;
  fields?: string[];
} {
  if (error instanceof z.ZodError)
    return {
      errorName: 'ZodError',
      fields: [
        ...new Set(
          error.issues.map((issue) =>
            issue.path.length > 0
              ? issue.path.map((part) => (typeof part === 'number' ? '[]' : String(part))).join('.')
              : '(root)',
          ),
        ),
      ]
        .filter((field) => /^[A-Za-z0-9_.[\]()]{1,80}$/.test(field))
        .slice(0, 20),
    };
  if (error instanceof ApiRequestError) return { errorName: 'ApiRequestError' };
  const name = error instanceof Error ? error.name : typeof error;
  return { errorName: /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error' };
}
