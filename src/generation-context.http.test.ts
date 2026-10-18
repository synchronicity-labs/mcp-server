import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { createHttpClient } from './http-client.js';
import { createAppTools } from './tools/app-tools.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const parentId = '00000000-0000-4000-8000-000000000002';
const otherProject = '00000000-0000-4000-8000-000000000003';

it.each([
  'accepted',
  'foreign-parent',
  'legacy',
] as const)('preserves continuation lineage and the original keyed request over HTTP: %s', async (scenario) => {
  const submissions: { key: unknown; workflow: unknown; parent: unknown; body: unknown }[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('content-type', 'application/json');
    if (req.url === `/v2/projects/${projectId}`) res.end(JSON.stringify({ id: projectId }));
    else if (req.url?.startsWith('/v2/generations/list?')) {
      res.end(
        JSON.stringify({
          items: [
            {
              id: parentId,
              projectId: scenario === 'foreign-parent' ? otherProject : projectId,
              status: 'COMPLETED',
              workflow: 'lipsync',
              modelName: 'sync-3',
              options: {},
              inputs: [],
              outputMediaUrl: 'https://fixture.invalid/output.mp4',
            },
          ],
        }),
      );
    } else if (req.url === '/v2/generate') {
      submissions.push({
        key: req.headers['idempotency-key'],
        workflow: req.headers['x-sync-workflow'],
        parent: req.headers['x-sync-parent-generation-id'],
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      if (submissions.length === 1)
        res.writeHead(503).end(JSON.stringify({ message: 'Try the same request' }));
      else res.end(JSON.stringify({ id: parentId, status: 'PROCESSING' }));
    } else res.writeHead(404).end('{}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  try {
    const http = createHttpClient(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
    const tool = createAppTools(http).find((item) => item.name === 'create-lipsync-from-assets')!;
    const args = {
      projectId,
      videoAssetId: 'saved-video',
      audioAssetId: 'saved-audio',
      idempotencyKey: 'original-saved-key',
      ...(scenario === 'legacy'
        ? {}
        : { continuation: { workflow: 'lipsync', parentGenerationId: parentId } }),
    };
    await expect(tool.handler(args)).rejects.toThrow();
    if (scenario === 'foreign-parent') {
      expect(submissions).toEqual([]);
      return;
    }
    expect(submissions).toHaveLength(1);
    await tool.handler(args);
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
    expect(submissions[0]).toMatchObject({
      key: 'original-saved-key',
      body: {
        projectId,
        input: [
          { type: 'video', assetId: 'saved-video' },
          { type: 'audio', assetId: 'saved-audio' },
        ],
      },
    });
    expect(submissions[0]!.workflow).toBe(scenario === 'legacy' ? undefined : 'lipsync');
    expect(submissions[0]!.parent).toBe(scenario === 'legacy' ? undefined : parentId);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
