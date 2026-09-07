import { describe, expect, it } from 'vitest';
import {
  createJsonToolResult,
  createToolDescriptorMeta,
  createToolErrorResult,
  SERVER_INSTRUCTIONS,
  selectHostedHttpTools,
} from './server.js';
import type { McpToolDefinition } from './tools/index.js';
import { UploadOverloadedError } from './upload-runtime.js';

function tool(name: string): McpToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: {},
    handler: async () => ({}),
  };
}

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

describe('SERVER_INSTRUCTIONS', () => {
  it('defaults ChatGPT lipsync generations to sync-3 and a reusable project', () => {
    expect(SERVER_INSTRUCTIONS).toContain('defaults both image and video generations to sync-3');
    expect(SERVER_INSTRUCTIONS).toContain('unless the user explicitly requests one');
    expect(SERVER_INSTRUCTIONS).toContain('reuses or creates that named project');
    expect(SERVER_INSTRUCTIONS).toContain('ChatGPT generations');
  });

  it('forbids routing local video through the upload widget', () => {
    expect(SERVER_INSTRUCTIONS).toContain('open-upload-widget is image/audio only');
    expect(SERVER_INSTRUCTIONS).toContain('Never call, recommend, or describe open-upload-widget');
    expect(SERVER_INSTRUCTIONS).toContain('Never mention requestedMediaType: "video"');
    expect(SERVER_INSTRUCTIONS).toContain('attaching the video to the ChatGPT composer');
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
