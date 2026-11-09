import { z } from 'zod';
import { ApiRequestError, cameFromApi } from './http-client.js';

const MAX_LENGTH = 300;

// What a tool's own error can carry from the call: quoted values, links, ids, paths,
// addresses and long numbers. The rest of these messages is fixed wording.
const REDACTIONS: [RegExp, string][] = [
  [/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|`[^`]*`/g, '"…"'],
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>'],
  [/\bdata:[^\s,]*,\S*/gi, '<url>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/[^\s@]+@[^\s@]+\.[^\s@]+/g, '<email>'],
  [/(?:~|\.{1,2})?\/(?:[^\s/]+\/)+[^\s/]*|\b[A-Za-z]:\\\S+/g, '<path>'],
  [/\d{4,}/g, '<n>'],
];

export function redactText(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of REDACTIONS)
    redacted = redacted.replace(pattern, replacement);
  return redacted.slice(0, MAX_LENGTH);
}

/**
 * Why a call failed, for logs, without what the caller sent. API errors carry only
 * their status and code: the API logs its own message. Validation errors name the
 * failing fields. This server's other errors keep their wording with values removed.
 */
export function errorSummary(error: unknown): string | undefined {
  if (error instanceof ApiRequestError && cameFromApi(error)) return undefined;
  if (error instanceof z.ZodError)
    return error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.code}`)
      .join('; ')
      .slice(0, MAX_LENGTH);
  return redactText(error instanceof Error ? error.message : String(error));
}
