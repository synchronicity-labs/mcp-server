import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { resolveClientProfile } from './client-profile.js';
import {
  createJsonToolResult,
  createToolDescriptorMeta,
  createToolErrorResult,
  registerTools,
  SERVER_INSTRUCTIONS,
  selectHostedHttpTools,
} from './server.js';
import type { McpToolDefinition } from './tools/index.js';
import { generationOutputSchema } from './tools/output-schemas.js';
import { UploadOverloadedError } from './upload-runtime.js';

function tool(name: string): McpToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: {},
    handler: async () => ({}),
  };
}

describe('registered tool labels', () => {
  it('advertises lowercase labels while preserving tool names and result data', async () => {
    const server = new McpServer({ name: 'sync', version: 'test' });
    const result = { outputUrl: 'https://Example.com/Video.mp4?Token=AbC' };
    registerTools(server, [
      {
        ...tool('projects_get-all'),
        resultFormat: 'json',
        title: 'List Sync Projects',
        meta: { 'openai/toolInvocation/invoking': 'Loading Sync Projects…' },
        handler: async () => result,
      },
    ]);
    const client = new Client({ name: 'test', version: 'test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect((await client.listTools()).tools[0]).toMatchObject({
        name: 'projects_get-all',
        title: 'list sync projects',
        _meta: { 'openai/toolInvocation/invoking': 'loading sync projects…' },
      });
      expect((await client.callTool({ name: 'projects_get-all' })).structuredContent).toEqual(
        result,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('createToolErrorResult', () => {
  it('preserves retry metadata in client-visible upload errors', () => {
    expect(createToolErrorResult(new UploadOverloadedError(2_500))).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'UPLOAD_CAPACITY_EXCEEDED',
          retryable: true,
          retryAfterMs: 2_500,
        },
      },
    });
  });

  it.each([null, undefined])('handles a nullish thrown value: %s', (error: null | undefined) => {
    expect(createToolErrorResult(error)).toEqual({
      content: [{ type: 'text', text: `Error: ${String(error)}` }],
      isError: true,
    });
  });
});

describe('createToolDescriptorMeta', () => {
  it('lowercases invocation labels without changing other metadata or the source', () => {
    const meta = {
      'openai/toolInvocation/invoking': 'Creating Your Lipsync Video…',
      'openai/toolInvocation/invoked': 'Lipsync Generation Started.',
      'openai/outputTemplate': 'ui://Sync/Studio.html',
      'openai/fileParams': ['sourceVideo'],
    };
    expect(createToolDescriptorMeta(meta)).toMatchObject({
      'openai/toolInvocation/invoking': 'creating your lipsync video…',
      'openai/toolInvocation/invoked': 'lipsync generation started.',
      'openai/outputTemplate': 'ui://Sync/Studio.html',
      'openai/fileParams': ['sourceVideo'],
    });
    expect(meta['openai/toolInvocation/invoking']).toBe('Creating Your Lipsync Video…');
  });

  it('adds OAuth security schemes for ChatGPT tool descriptors', () => {
    expect(createToolDescriptorMeta(undefined)).toEqual({
      securitySchemes: [{ type: 'oauth2', scopes: [] }],
    });
  });

  it('preserves existing tool metadata', () => {
    expect(
      createToolDescriptorMeta({
        'openai/fileParams': ['image'],
      }),
    ).toEqual({
      'openai/fileParams': ['image'],
      securitySchemes: [{ type: 'oauth2', scopes: [] }],
    });
  });
});

describe('createJsonToolResult', () => {
  it('exposes JSON object results as structured content and text', () => {
    const result = {
      id: 'gen-123',
      status: 'PENDING',
      outputUrl: null,
    };

    expect(createJsonToolResult(result)).toEqual({
      structuredContent: result,
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    });
  });

  it('leaves array results as text-only JSON', () => {
    const result = [{ id: 'voice-1' }];

    expect(createJsonToolResult(result)).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    });
  });

  // The browser cannot render the backend ETA if the MCP public projection strips it.
  it('forwards server generation estimates without exposing private inputs', () => {
    const generationEstimate = {
      serverTime: '2026-10-01T12:00:00Z',
      estimatedFinishAt: '2026-10-01T12:00:40Z',
    };
    const result = createJsonToolResult(
      {
        id: 'gen-123',
        status: 'PROCESSING',
        generationEstimate,
        input: [{ url: 'https://private.example/input.mp4' }],
      },
      generationOutputSchema,
    );
    expect(result.structuredContent).toEqual({
      id: 'gen-123',
      status: 'PROCESSING',
      generationEstimate,
    });
  });

  it('projects structured content to output schema fields when provided', () => {
    const result = {
      id: 'gen-123',
      status: 'COMPLETED',
      input: [{ url: 'https://storage.example/private-input.mp4' }],
      outputUrl: 'https://api.sync.so/result',
    };
    const expected = {
      id: 'gen-123',
      status: 'COMPLETED',
      outputUrl: 'https://api.sync.so/result',
    };

    expect(
      createJsonToolResult(result, {
        id: {},
        status: {},
        outputUrl: {},
      }),
    ).toEqual({
      structuredContent: expected,
      content: [
        {
          type: 'text',
          text: JSON.stringify(expected, null, 2),
        },
      ],
    });
  });
});

describe('SERVER_INSTRUCTIONS', () => {
  it('documents the concise lipsync input contract and defaults', () => {
    expect(SERVER_INSTRUCTIONS).toContain('exactly one visual input');
    expect(SERVER_INSTRUCTIONS).toContain('one driver');
    expect(SERVER_INSTRUCTIONS).toContain('defaults to sync-3');
    expect(SERVER_INSTRUCTIONS).toContain('NEW project');
  });

  it('describes only tools available to every profile and exact result handling', () => {
    expect(SERVER_INSTRUCTIONS).toContain('voices_get-voices');
    expect(SERVER_INSTRUCTIONS).toContain('Create once');
    expect(SERVER_INSTRUCTIONS).toContain('exact structuredContent.outputUrl');
    expect(SERVER_INSTRUCTIONS).not.toContain('open-upload-widget');
    expect(SERVER_INSTRUCTIONS).not.toContain('tts_create');
  });
});

describe('selectHostedHttpTools', () => {
  it('exposes app discovery and generation tools without exposing unrelated writes', () => {
    const tools = [
      tool('assets_create'),
      tool('assets_create-upload-url'),
      tool('projects_create'),
      tool('open-upload-widget'),
      tool('upload-media'),
      tool('create-lipsync'),
      tool('models_get'),
      tool('voices_get-voices'),
      tool('generate_get-generation'),
      tool('projects_get-all'),
      tool('projects_delete'),
      tool('assets_delete'),
    ];

    expect(
      selectHostedHttpTools(tools, resolveClientProfile('chatgpt')).map((t) => t.name),
    ).toEqual([
      'assets_create',
      'assets_create-upload-url',
      'projects_create',
      'open-upload-widget',
      'upload-media',
      'create-lipsync',
      'models_get',
      'voices_get-voices',
      'generate_get-generation',
      'projects_get-all',
      'assets_delete',
    ]);
  });

  it('marks hosted data tools callable from the upload widget', () => {
    const tools = [
      tool('open-upload-widget'),
      tool('upload-media'),
      tool('create-lipsync'),
      tool('voices_get-voices'),
      tool('generate_get-generation'),
    ];

    const selected = selectHostedHttpTools(tools, resolveClientProfile('chatgpt'));
    const widgetCallableTools = selected.filter((t) => t.name !== 'open-upload-widget');

    expect(widgetCallableTools.map((t) => t.name)).toEqual([
      'upload-media',
      'create-lipsync',
      'voices_get-voices',
      'generate_get-generation',
    ]);
    for (const selectedTool of widgetCallableTools) {
      expect(selectedTool.meta?.['openai/widgetAccessible']).toBe(true);
      expect(selectedTool.meta?.ui).toEqual({ visibility: ['model', 'app'] });
    }
  });
});
