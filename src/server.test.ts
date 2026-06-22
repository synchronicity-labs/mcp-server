import { describe, expect, it } from 'vitest';
import { createToolDescriptorMeta, selectHostedHttpTools } from './server.js';
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

describe('selectHostedHttpTools', () => {
  it('keeps only the lean ChatGPT lipsync flow tools in original order', () => {
    const tools = [
      tool('assets_create'),
      tool('upload-media'),
      tool('create-lipsync'),
      tool('models_get'),
      tool('voices_get-voices'),
      tool('generate_get-generation'),
      tool('projects_get-all'),
    ];

    expect(selectHostedHttpTools(tools).map((t) => t.name)).toEqual([
      'upload-media',
      'create-lipsync',
      'voices_get-voices',
      'generate_get-generation',
    ]);
  });
});
