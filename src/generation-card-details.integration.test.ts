import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createMcpServerFactory } from './server.js';

// An accepted job must remain readable when optional context is unavailable;
// source media and project names must come only from authorized, matching reads.
afterEach(() => vi.unstubAllGlobals());
it('returns measured progress and authorized card details without exposing source inputs', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const projectId = '00000000-0000-4000-8000-000000000002';
  const assetId = '00000000-0000-4000-8000-000000000003';
  const thumbnailUrl = 'https://fixture.invalid/thumbnail.jpg?Signature=a%2Fb';
  let mode = 'available';
  const paths: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const request = new URL(url);
    const path = request.pathname;
    if (path === '/api-json')
      return Response.json({
        openapi: '3.0.0',
        paths: {
          '/v2/generate/{id}': {
            get: {
              operationId: 'GenerateController_getGeneration',
              tags: ['Generate'],
              parameters: [
                { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                { name: 'include', in: 'query', schema: { type: 'string' } },
              ],
            },
          },
        },
      });
    paths.push(path);
    if (path === `/v2/generate/${id}`) {
      if (mode === 'refused')
        return Response.json({ message: 'Access unavailable' }, { status: 403 });
      expect(request.searchParams.get('include')).toBe('progress');
      return Response.json({
        id,
        projectId,
        status: 'PROCESSING',
        model: 'sync-3',
        input: [{ type: 'video', assetId, url: 'https://fixture.invalid/private.mp4' }],
        progress: {
          stage: 'processing',
          privateProgress: 'hidden',
          percent: 40,
          completedTasks: 2,
          runningTasks: 1,
          waitingTasks: 2,
        },
      });
    }
    if (mode === 'unavailable') return Response.json({ message: 'Not found' }, { status: 404 });
    if (path === `/v2/projects/${projectId}`)
      return Response.json({ id: projectId, name: 'Product launch', privateNotes: 'hidden' });
    if (path === `/v2/assets/${assetId}`)
      return Response.json({
        id: mode === 'mismatched' ? projectId : assetId,
        name: 'launch.mp4',
        thumbnailUrl,
        durationSeconds: 47,
        url: 'https://fixture.invalid/private.mp4',
      });
    if (path === `/v2/generations/${id}/dubbing`)
      return Response.json({
        dubbing: { sourceLang: 'en', targetLang: 'de', startedWithGeneration: true },
      });
    return Response.json({}, { status: 404 });
  });
  const server = (
    await createMcpServerFactory({ baseUrl: 'https://fixture.invalid', transport: 'http', port: 0 })
  ).createServer();
  const client = new Client({ name: 'openai-mcp', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const read = () =>
    client.callTool({ name: 'generate_get-generation', arguments: { id, include: 'progress' } });
  try {
    const result = await read();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      id,
      status: 'PROCESSING',
      progress: { percent: 40, completedTasks: 2 },
      display: {
        title: 'Product launch',
        thumbnailUrl,
        durationSeconds: 47,
        sourceLang: 'en',
        targetLang: 'de',
      },
    });
    expect(JSON.stringify(result)).not.toContain('private.mp4');
    expect(JSON.stringify(result)).not.toContain('privateNotes');
    expect(JSON.stringify(result)).not.toContain('privateProgress');
    mode = 'unavailable';
    const unavailable = await read();
    expect(unavailable.isError).not.toBe(true);
    expect(unavailable.structuredContent).toMatchObject({
      id,
      status: 'PROCESSING',
      progress: { percent: 40 },
    });
    expect((unavailable.structuredContent as Record<string, unknown>).display).not.toHaveProperty(
      'thumbnailUrl',
    );
    mode = 'mismatched';
    const mismatched = await read();
    expect((mismatched.structuredContent as Record<string, unknown>).display).not.toHaveProperty(
      'thumbnailUrl',
    );
    mode = 'refused';
    paths.length = 0;
    expect((await read()).isError).toBe(true);
    expect(paths).toEqual([`/v2/generate/${id}`]);
  } finally {
    await client.close();
    await server.close();
  }
});
