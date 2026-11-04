import { createRequire } from 'node:module';

// Report the published package version, not a hand-maintained copy.
export const { version: PACKAGE_VERSION } = createRequire(import.meta.url)('../package.json') as {
  version: string;
};
