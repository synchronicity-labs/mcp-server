import { describe, expect, it } from 'vitest';
import { createJsonToolResult, createToolDescriptorMeta, selectHostedHttpTools } from './server.js';
import type { McpToolDefinition } from './tools/index.js';

function tool(name: string): McpToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: {},
    handler: async () => ({}),
  };
}

describe('createToolDescriptorMeta', () => {
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

describe('selectHostedHttpTools', () => {
  it('keeps only the lean ChatGPT lipsync flow tools in original order', () => {
    const tools = [
      tool('assets_create'),
      tool('open-upload-widget'),
      tool('upload-media'),
      tool('create-lipsync'),
      tool('models_get'),
      tool('voices_get-voices'),
      tool('generate_get-generation'),
      tool('projects_get-all'),
    ];

    expect(selectHostedHttpTools(tools).map((t) => t.name)).toEqual([
      'open-upload-widget',
      'upload-media',
      'create-lipsync',
      'voices_get-voices',
      'generate_get-generation',
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

    const selected = selectHostedHttpTools(tools);
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
