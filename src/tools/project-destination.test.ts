import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createProjectId } from './project-destination.js';

// The project id derived from a projectCreationKey is how a retry finds the project its
// first attempt created, so it must never change between releases.
function releasedDerivation(projectCreationKey: string, idempotencyKey: string): string {
  const bytes = createHash('sha256')
    .update('sync:mcp:new-project:v1\0')
    .update(projectCreationKey.toLowerCase())
    .update('\0')
    .update(idempotencyKey)
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe('createProjectId', () => {
  it.each([
    ['6F1F8C63-41A4-4F55-9D4E-2F7C1F7B1F10', 'generation-key-1'],
    ['00000000-0000-4000-8000-0000000000e1', ''],
  ])('derives the same project id as released versions for %s', async (creationKey, key) => {
    const request = vi.fn(async (_method: string, _path: string, options?: { body?: unknown }) => ({
      id: (options!.body as { id: string }).id,
    }));
    const id = await createProjectId(
      { request },
      {
        name: 'p',
        projectCreationKey: creationKey,
        idempotencyKey: key || undefined,
        defaultWorkflow: 'lipsync',
      },
    );
    expect(id).toBe(releasedDerivation(creationKey, key));
  });
});
