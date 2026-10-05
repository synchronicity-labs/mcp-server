import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const chatgptReleaseSchema = z
  .object({ current: digest, previous: z.array(digest).max(8) })
  .strict()
  .refine(
    ({ current, previous }) => new Set([current, ...previous]).size === previous.length + 1,
    'Release hashes must be unique.',
  );

/** The image owns release selection; legacy environment paths remain readable. */
export function resolveChatgptRelease(catalogPath: string, legacyDirectories: string[]) {
  const catalog = chatgptReleaseSchema.parse(JSON.parse(readFileSync(catalogPath, 'utf8')));
  const root = dirname(resolve(catalogPath));
  const directory = resolve(root, catalog.current);
  const previousDirectories = [
    ...new Set([
      ...catalog.previous.map((hash) => resolve(root, hash)),
      ...legacyDirectories
        .map((path) => resolve(path))
        // The catalog owns packaged retention, including intentionally pruned releases.
        .filter((path) => dirname(path) !== root || !digest.safeParse(basename(path)).success),
    ]),
  ].filter((path) => path !== directory);
  return { directory, previousDirectories };
}
