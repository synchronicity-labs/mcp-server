import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createMcpServerFactory, createSyncMcpServer } from './server.js';
import { translationSpec } from './test-fixtures/translation.js';

afterEach(() => vi.unstubAllGlobals());

it.each(['http', 'stdio'] as const)(
  'attaches a readable status card to every %s video submission without requiring the Studio bundle',
  async (transport) => {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        ...translationSpec,
        paths: {
          ...translationSpec.paths,
          '/v2/transcriptions': {
            post: { operationId: 'Transcriptions_create', tags: ['Transcriptions'] },
          },
          '/v2/transcriptions/{id}': {
            get: { operationId: 'Transcriptions_get', tags: ['Transcriptions'] },
          },
          '/v2/dialogue-edits': {
            post: {
              operationId: 'DialogueEdits_create',
              tags: ['Dialogue Edits'],
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { edits: { type: 'array', items: { type: 'object' } } },
                    },
                  },
                },
              },
            },
          },
          '/v2/dialogue-edits/{id}': {
            get: { operationId: 'DialogueEdits_get', tags: ['Dialogue Edits'] },
          },
        },
      }),
    );
    const config = {
      baseUrl: 'https://fixture.invalid',
      transport,
      port: 0,
      apiKey: 'fixture-key',
    };
    const server =
      transport === 'stdio'
        ? await createSyncMcpServer(config)
        : (await createMcpServerFactory(config)).createServer();
    const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const { tools } = await client.listTools();
      const submissions = [
        'create-lipsync',
        'create-lipsync-from-assets',
        'create-translate-and-dub',
        'create-dialogue-video',
        ...(transport === 'stdio' ? ['generate_create-generation'] : []),
      ];
      for (const name of submissions) {
        const tool = tools.find((entry) => entry.name === name);
        expect(tool, name).toBeDefined();
        expect(tool?._meta).toMatchObject({
          ui: { resourceUri: 'ui://sync/generation-status-v1.html' },
          'openai/outputTemplate': 'ui://sync/generation-status-v1.html',
        });
      }
      const { contents } = await client.readResource({
        uri: 'ui://sync/generation-status-v1.html',
      });
      expect(contents[0]).toMatchObject({
        mimeType: 'text/html;profile=mcp-app',
        text: expect.stringContaining('Check status'),
      });
      expect((await client.listResources()).resources.map((item) => item.uri)).toContain(
        'ui://sync/generation-status-v1.html',
      );
    } finally {
      await client.close();
      await server.close();
    }
  },
);
