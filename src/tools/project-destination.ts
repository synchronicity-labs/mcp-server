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
  if (idempotencyKey && !projectCreationKey)
    throw new Error(
      'A new project needs a fresh projectCreationKey. Persist it with the idempotencyKey and reuse both on retries.',
    );
  let id: string | undefined;
  if (projectCreationKey !== undefined) {
    z.uuid().parse(projectCreationKey);
    // A creation key cannot be substituted with an existing project's UUID.
    const bytes = createHash('sha256')
      .update('sync:mcp:new-project:v1\0')
      .update(projectCreationKey.toLowerCase())
      .update('\0')
      .update(idempotencyKey ?? '')
      .digest();
    bytes[6] = (bytes[6]! & 0x0f) | 0x80;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.subarray(0, 16).toString('hex');
    id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
