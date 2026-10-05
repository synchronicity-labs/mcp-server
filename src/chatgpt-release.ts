import { existsSync, readFileSync } from 'node:fs';
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
        // Ignore only absent old image pins; a mount at the same path must stay readable.
        .filter(
          (path) =>
            dirname(path) !== root || !digest.safeParse(basename(path)).success || existsSync(path),
        ),
    ]),
  ].filter((path) => path !== directory);
  z.array(z.string())
    .max(8, {
      message:
        'ChatGPT UI retention exceeds eight previous bundles across the release manifest and legacy settings. Retire unused releases explicitly before deploying.',
    })
    .parse(previousDirectories);
  return { directory, previousDirectories };
}
