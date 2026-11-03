import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { runWithAuth } from '../auth/async-context.js';
import { createMcpServerFactory } from '../server.js';
import { asyncRequestListener } from './request-listener.js';

export const projectId = '00000000-0000-4000-8000-000000000001';
export const videoAssetId = '00000000-0000-4000-8000-000000000002';
export const transcriptionId = '00000000-0000-4000-8000-000000000003';
export const dialogueEditId = '00000000-0000-4000-8000-000000000004';
export const uploadedAssetId = '00000000-0000-4000-8000-000000000006';
export const externalUrl = 'http://93.184.216.34/external.mp4';
export const source = { projectId, videoAssetId };
export const sourceVideoUrl = 'https://cdn.sync.so/saved-source.mp4';
export const transcript = {
  speakerCount: 1,
  segments: [{ id: 's1', words: [{ id: 'w1', text: 'Hello', startMs: 100, endMs: 500 }] }],
};
export const edits = [{ kind: 'change', wordId: 'w1', replacement: 'Hi' }];
export const estimate = {
  estimatedFrameCount: 60,
  estimatedGenerationCost: 0.32,
  estimatedCredits: 32,
};
const bodies = {
  transcriptions: {
    sourceVideoUrl: { type: 'string' },
    projectId: { type: 'string' },
    maxSourceSeconds: { type: 'number' },
  },
  'dialogue-edits': {
    sourceVideoUrl: { type: 'string' },
    projectId: { type: 'string' },
    transcript: { type: 'object' },
    edits: { type: 'array', items: { type: 'object' } },
    voiceId: { type: 'string' },
    rerunOfJobId: { type: 'string' },
    transcriptionJobId: { type: 'string' },
  },
};
const spec = {
  openapi: '3.0.0',
  paths: Object.fromEntries(
    Object.entries(bodies).flatMap(([resource, properties]) => [
      [
        `/v2/${resource}`,
        {
          post: {
            operationId: `${resource}_create`,
            tags: [resource === 'transcriptions' ? 'Transcriptions' : 'Dialogue Edits'],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties,
                    required:
                      resource === 'dialogue-edits'
                        ? ['sourceVideoUrl', 'transcript', 'edits']
                        : ['sourceVideoUrl'],
                  },
                },
              },
            },
          },
        },
      ],
      [
        `/v2/${resource}/{id}`,
        {
          get: {
            operationId: `${resource}_get`,
            tags: [resource === 'transcriptions' ? 'Transcriptions' : 'Dialogue Edits'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          },
        },
      ],
    ]),
  ),
};
const clients: Client[] = [],
  servers: McpServer[] = [],
  upstreams: Server[] = [];
/** Closes every client, server and upstream the fixtures opened. */
export async function closeDialogueFixtures(): Promise<void> {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const server of upstreams.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
export async function dialogueFixture(
  options: {
    denied?: boolean;
    external?: boolean;
    uploadRejected?: boolean;
    mismatched?: boolean;
    lostPreview?: boolean;
    keyedPreview?: boolean;
    rotatingAssetUrl?: boolean;
    hostedTranscriptionFails?: boolean;
    previewStatus?: 'COMPLETED' | 'COMPLETED_PARTIAL';
    partialDetail?: {
      slotsTotal: number;
      slotsOk: number;
      failedSlots: { index: number; errorCode: string }[];
    };
  } = {},
) {
  const calls: { path: string; body?: Record<string, unknown>; token?: string; key?: string }[] =
    [];
  const transcriptionRejection = (body: Record<string, unknown>) =>
    body.sourceVideoUrl !== sourceVideoUrl
      ? {
          status: 422,
          message:
            'Transcription sources must be hosted in sync. labs storage. Upload the file via POST /v2/assets/upload first, then transcribe the returned url.',
        }
      : options.hostedTranscriptionFails
        ? { status: 503, message: 'Transcription is temporarily unavailable.' }
        : undefined;
  const upstream = createServer(
    asyncRequestListener(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api-json') {
        const current = structuredClone(spec);
        if (options.keyedPreview)
          Object.assign(current.paths['/v2/dialogue-edits']!.post!, {
            parameters: [
              {
                name: 'Idempotency-Key',
                in: 'header',
                required: false,
                schema: { type: 'string' },
              },
            ],
          });
        res.end(JSON.stringify(current));
        return;
      }
      if (req.url === '/external.mp4') {
        calls.push({ path: req.url });
        res.setHeader('Content-Type', 'video/mp4');
        res.end('external video bytes');
        return;
      }
      if (req.url === '/storage') {
        let bytes = '';
        for await (const chunk of req) bytes += chunk.toString();
        calls.push({ path: req.url, body: { bytes } });
        res.statusCode = options.uploadRejected ? 403 : 200;
        res.end();
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk.toString();
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({
        path: req.url!,
        body,
        token: req.headers.authorization,
        key: req.headers['idempotency-key'] as string | undefined,
      });
      if (options.denied) {
        res.statusCode = 403;
        res.end(JSON.stringify({ message: 'Project denied' }));
        return;
      }
      let value: unknown;
      if (req.url === `/v2/projects/${projectId}`) value = { id: projectId };
      else if (req.url === `/v2/assets/${videoAssetId}`)
        value = {
          id: videoAssetId,
          type: 'VIDEO',
          url: options.external
            ? externalUrl
            : options.rotatingAssetUrl
              ? `${sourceVideoUrl}?read=${calls.length}`
              : sourceVideoUrl,
        };
      else if (req.url === '/v2/assets/upload')
        value = { uploadUrl: `http://${req.headers.host}/storage`, url: sourceVideoUrl };
      else if (req.url === '/v2/assets' || req.url === `/v2/assets/${uploadedAssetId}`)
        value = {
          id: uploadedAssetId,
          type: 'VIDEO',
          url: sourceVideoUrl,
          name: 'Interview.mp4',
          durationSeconds: 2,
        };
      else if (req.url?.startsWith('/v2/transcriptions')) {
        const rejection = req.method === 'POST' ? transcriptionRejection(body) : undefined;
        if (rejection) {
          res.statusCode = rejection.status;
          res.end(JSON.stringify({ message: rejection.message }));
          return;
        }
        value = {
          id: transcriptionId,
          status: 'COMPLETED',
          sourceVideoUrl: options.mismatched ? 'https://cdn.sync.so/other.mp4' : sourceVideoUrl,
          transcript,
        };
      } else if (req.url?.startsWith('/v2/dialogue-edits')) {
        if (req.method === 'POST' && options.lostPreview) {
          res.statusCode = 503;
          res.end(JSON.stringify({ message: 'Unknown outcome' }));
          return;
        }
        value = {
          id: dialogueEditId,
          status: options.previewStatus ?? 'COMPLETED',
          sourceVideoUrl,
          sourceTranscript: transcript,
          edits,
          voiceId: 'original-speaker',
          ...(options.partialDetail ? { partialDetail: options.partialDetail } : {}),
        };
      } else if (req.url === '/v2/analyze/cost') value = estimate;
      else if (req.url === '/v2/generate') value = { id: dialogueEditId, status: 'PENDING' };
      else {
        res.statusCode = 404;
        value = {};
      }
      res.end(JSON.stringify(value));
    }),
  );
  upstreams.push(upstream);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const factory = await createMcpServerFactory({
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    transport: 'http',
    port: 0,
  });
  const server = factory.createServer();
  servers.push(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  clients.push(client);
  await client.connect(ct);
  const call = (name: string, args: Record<string, unknown>) =>
    runWithAuth('dialogue-reader', 'openai-mcp', () =>
      client.callTool({ name, arguments: { ...args, projectIntent: 'explicit' } }),
    );
  return { calls, client, call, port: (upstream.address() as AddressInfo).port };
}
