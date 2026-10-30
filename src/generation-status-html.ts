import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';

// Built from the companion workspace's real @sync/ui components and brand tokens.
const directory = new URL('../deploy/generation-status/', import.meta.url);
const release = z
  .object({
    repository: z.literal('synchronicity-labs/sync-api-v2'),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    htmlSha256: z.string().regex(/^[a-f0-9]{64}$/),
    htmlBytes: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024),
  })
  .parse(JSON.parse(readFileSync(new URL('release.json', directory), 'utf8')));
const html = gunzipSync(readFileSync(new URL('app.html.gz', directory)), {
  maxOutputLength: 8 * 1024 * 1024,
});
if (
  html.length !== release.htmlBytes ||
  createHash('sha256').update(html).digest('hex') !== release.htmlSha256
) {
  throw new Error('Generation status UI does not match its approved release.');
}
export const GENERATION_STATUS_HTML = html.toString('utf8');
