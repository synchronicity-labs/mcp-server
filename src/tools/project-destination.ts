import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HttpClient } from '../http-client.js';

export const newProjectFields = {
  projectCreationKey: z
    .uuid()
    .optional()
    .describe(
      'Fresh random UUID identifying this NEW project creation, not a project ID. Required for keyed generation without projectId. Persist this key, name and generation key on retries; the server derives a separate project UUID.',
    ),
};

/**
 * A deterministic version 8 UUID from the SHA-256 of the parts, each separated by a NUL
 * byte: an idempotent id for a retry to find again, not a password hash. Callers pass only
 * caller-chosen keys and identifiers, never credentials or tokens.
 */
export function hashUuid(...parts: string[]): string {
  const bytes = createHash('sha256').update(parts.join('\0')).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function assertProjectDestination(
  projectId?: string,
  projectName?: string,
  projectCreationKey?: string,
): void {
  if (projectId !== undefined && !projectId.trim()) throw new Error('projectId must not be empty.');
  if (projectId !== undefined && projectName !== undefined)
    throw new Error('Provide either projectId or projectName, not both.');
  if (projectId !== undefined && projectCreationKey !== undefined)
    throw new Error('Provide either projectId or projectCreationKey, not both.');
  if (projectName !== undefined && !projectName.trim())
    throw new Error('projectName must not be empty.');
}

export async function createProjectId(
  http: HttpClient,
  {
    name,
    projectCreationKey,
    idempotencyKey,
    defaultWorkflow,
  }: {
    name: string;
    projectCreationKey?: string;
    idempotencyKey?: string;
    defaultWorkflow: 'lipsync' | 'image_to_video' | 'translate_and_dub';
  },
  signal?: AbortSignal,
): Promise<string> {
  // Clients holding a tool list from before projectCreationKey existed still send keyed
  // requests. They get an unkeyed new project; only a lost-response retry can then conflict.
  let id: string | undefined;
  if (projectCreationKey !== undefined) {
    z.uuid().parse(projectCreationKey);
    // A creation key cannot be substituted with an existing project's UUID.
    id = hashUuid(
      'sync:mcp:new-project:v1',
      projectCreationKey.toLowerCase(),
      idempotencyKey ?? '',
    );
  }
  signal?.throwIfAborted();
  const project = z.object({ id: z.string().min(1) }).parse(
    await http.request('post', '/v2/projects', {
      signal,
      body: { name, defaultWorkflow, ...(id ? { id } : {}) },
    }),
  );
  if (id && project.id !== id)
    throw new Error('Sync returned a different project than the one requested.');
  return project.id;
}
