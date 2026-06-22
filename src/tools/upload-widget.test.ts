import type {
  ReadResourceCallback,
  ResourceMetadata,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import {
  createUploadWidgetTool,
  registerUploadWidgetResource,
  UPLOAD_WIDGET_HTML,
  UPLOAD_WIDGET_LEGACY_URIS,
  UPLOAD_WIDGET_URI,
} from './upload-widget.js';

describe('createUploadWidgetTool', () => {
  it('declares the ChatGPT render template metadata', () => {
    const tool = createUploadWidgetTool();

    expect(tool.name).toBe('open-upload-widget');
    expect(tool.title).toBe('Open image/audio upload widget');
    expect(tool.description).toContain('cannot accept video or MP4');
    expect(tool.description).toContain('Never use, recommend, or describe this tool');
    expect(tool.description).toContain('never use requestedMediaType: "video"');
    expect(tool.resultFormat).toBe('mcp');
    expect(tool.meta?.ui).toEqual({
      resourceUri: UPLOAD_WIDGET_URI,
      visibility: ['model', 'app'],
    });
    expect(tool.meta?.['openai/outputTemplate']).toBe(UPLOAD_WIDGET_URI);
    expect(tool.meta?.['openai/widgetAccessible']).toBe(true);
  });

  it('returns structured widget input as a raw MCP result', async () => {
    const tool = createUploadWidgetTool();
    if (tool.resultFormat !== 'mcp') {
      throw new Error('open-upload-widget must return a raw MCP result');
    }
    const result = await tool.handler({
      requestedMediaType: 'image',
    });

    expect(result.structuredContent).toEqual({
      requestedMediaType: 'image',
      script: undefined,
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
    });
  });

  it('does not accept video as a requested widget media type', async () => {
    const tool = createUploadWidgetTool();
    if (tool.resultFormat !== 'mcp') {
      throw new Error('open-upload-widget must return a raw MCP result');
    }
    const result = await tool.handler({
      requestedMediaType: 'video',
    });

    expect(result.structuredContent).toEqual({
      requestedMediaType: undefined,
      script: undefined,
    });
  });
});

describe('UPLOAD_WIDGET_HTML', () => {
  it('uses ChatGPT file APIs and calls the upload-media tool', () => {
    expect(UPLOAD_WIDGET_HTML).toContain('openai.selectFiles');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.uploadFile');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.getFileDownloadUrl');
    expect(UPLOAD_WIDGET_HTML).not.toContain('accept="image/*,video/*,audio/*"');
    expect(UPLOAD_WIDGET_HTML).toContain('accept="image/*,audio/*"');
    expect(UPLOAD_WIDGET_HTML).toContain('Attach videos in chat first.');
    expect(UPLOAD_WIDGET_HTML).toContain(
      'The upload widget supports images and audio only. Attach videos in the ChatGPT composer',
    );
    expect(UPLOAD_WIDGET_HTML).not.toContain('videoAssetId');
    expect(UPLOAD_WIDGET_HTML).not.toContain('lowerMime.indexOf("video/")');
    expect(UPLOAD_WIDGET_HTML).not.toContain('mp4|mov|m4v|webm');
    expect(UPLOAD_WIDGET_HTML).toContain('sourceOpenai.toolOutput');
    expect(UPLOAD_WIDGET_HTML).toContain('openai:set_globals');
    expect(UPLOAD_WIDGET_HTML).toContain('mcpToolResult._meta');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.callTool("upload-media"');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.callTool("voices_get-voices"');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.callTool("create-lipsync"');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.callTool("generate_get-generation"');
    expect(UPLOAD_WIDGET_HTML).toContain('id="scriptInput"');
    expect(UPLOAD_WIDGET_HTML).toContain('id="runLipsync"');
  });
});

describe('registerUploadWidgetResource', () => {
  it('keeps legacy template URIs readable for cached ChatGPT sessions', async () => {
    const registrations: Array<{
      name: string;
      uri: string;
      readCallback: ReadResourceCallback;
    }> = [];
    const server = {
      registerResource: (
        name: string,
        uri: string,
        _metadata: ResourceMetadata,
        readCallback: ReadResourceCallback,
      ) => {
        registrations.push({ name, uri, readCallback });
      },
    };

    registerUploadWidgetResource(server);

    expect(registrations.map((registration) => registration.uri)).toEqual([
      UPLOAD_WIDGET_URI,
      ...UPLOAD_WIDGET_LEGACY_URIS,
    ]);
    expect(registrations.map((registration) => registration.name)).toEqual([
      'sync-upload-widget-v7',
      'sync-upload-widget-v1',
      'sync-upload-widget-v2',
      'sync-upload-widget-v3',
      'sync-upload-widget-v4',
      'sync-upload-widget-v5',
      'sync-upload-widget-v6',
    ]);

    const legacyRegistration = registrations.find(
      (registration) => registration.uri === 'ui://sync/upload-widget-v6.html',
    );
    const extra = {
      signal: new AbortController().signal,
      requestId: 1,
      sendNotification: async () => {},
      sendRequest: async () => {
        throw new Error('not implemented');
      },
    } satisfies Parameters<ReadResourceCallback>[1];
    const result = await legacyRegistration?.readCallback(
      new URL('ui://sync/upload-widget-v6.html'),
      extra,
    );

    expect(result?.contents[0]).toMatchObject({
      uri: 'ui://sync/upload-widget-v6.html',
      text: UPLOAD_WIDGET_HTML,
    });
  });
});
