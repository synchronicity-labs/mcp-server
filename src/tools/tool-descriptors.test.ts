import { describe, expect, it, vi } from 'vitest';
import { resolveClientProfile } from '../client-profile.js';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import { SERVER_INSTRUCTIONS, selectHostedHttpTools } from '../server.js';
import { createAssetCreatorsTool } from './asset-creators.js';
import { generateTools, operationIdToToolName } from './generator.js';

const http: HttpClient = { request: vi.fn() };
const operation = (operationId: string, method: ParsedOperation['method']): ParsedOperation => ({
  operationId,
  method,
  path: `/v2/${operationId}`,
  summary: operationId,
  tags: [],
  parameters: [],
  isMultipart: false,
});
// Hosted and non-hosted operations, so descriptions can't point ChatGPT at hidden tools.
const operations = [
  operation('ModelsController_get', 'get'),
  operation('VoicesController_getVoices', 'get'),
  operation('VoicesController_cloneVoice', 'post'),
  operation('VoicesController_deleteVoice', 'delete'),
  operation('AssetsController_createUploadUrl', 'post'),
  operation('AssetsController_create', 'post'),
  operation('AssetsController_getAll', 'get'),
  operation('AssetsController_count', 'get'),
  operation('AssetsController_get', 'get'),
  operation('AssetsController_getDownloadUrl', 'get'),
  operation('AssetsController_update', 'patch'),
  operation('AssetsController_delete', 'delete'),
  operation('TtsController_create', 'post'),
  operation('GenerateController_createGeneration', 'post'),
  operation('GenerateController_getGenerations', 'get'),
  operation('GenerateController_estimateCost', 'post'),
  operation('GenerationsController_delete', 'delete'),
  operation('ProjectsController_create', 'post'),
  operation('ProjectsController_getAll', 'get'),
  operation('ProjectsController_get', 'get'),
  operation('ProjectsController_update', 'patch'),
  operation('ProjectsController_delete', 'delete'),
];
const chatgpt = resolveClientProfile('openai-mcp');

describe('ChatGPT tool descriptors', () => {
  const generated = generateTools(operations, http);
  const hosted = selectHostedHttpTools(generated, chatgpt);

  it('gives every hosted generated tool a written title', () => {
    expect(hosted.length).toBeGreaterThan(10);
    for (const tool of hosted) {
      const mechanical = tool.name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.title, tool.name).not.toBe(mechanical);
    }
  });

  it('never refers ChatGPT to a tool it cannot call', () => {
    const visible = new Set(hosted.map((tool) => tool.name));
    const hidden = [
      ...new Set([
        ...operations.map((op) => operationIdToToolName(op.operationId)),
        ...generated.map((tool) => tool.name),
      ]),
    ].filter((name) => !visible.has(name));
    expect(hidden).toContain('generate_create-generation');
    for (const [source, text] of [
      ['server instructions', SERVER_INSTRUCTIONS],
      ...hosted.map((tool) => [tool.name, tool.description ?? ''] as const),
    ]) {
      for (const name of hidden) expect(text, `${source} mentions ${name}`).not.toContain(name);
    }
  });

  it('keeps organization member emails out of the model context', () => {
    const [creators] = selectHostedHttpTools([createAssetCreatorsTool(http)], chatgpt);
    expect(creators?.meta).toMatchObject({
      ui: { visibility: ['app'] },
      'openai/widgetAccessible': true,
    });
    expect(creators?.description).toContain('email');
  });
});
