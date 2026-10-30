import { readFileSync } from 'node:fs';

/**
 * The commit this process runs. The deploy job writes it to `.revision` in the image;
 * local and test runs fall back to the environment.
 */
export const REVISION = readRevision();

function readRevision(): string {
  try {
    const value = readFileSync(new URL('../.revision', import.meta.url), 'utf8').trim();
    if (value && value !== 'unknown') return value;
  } catch {
    // No revision file outside a deployed image.
  }
  return process.env.PORTER_TAG ?? process.env.GIT_SHA ?? process.env.K_REVISION ?? 'unknown';
}
