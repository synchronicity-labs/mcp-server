import { runInNewContext } from 'node:vm';
import type {
  ReadResourceCallback,
  ReadResourceResult,
  ResourceMetadata,
} from '@modelcontextprotocol/server';
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

    expect(tool.name).toBe('assets_open-upload-widget');
    expect(tool.title).toBe('Open image/audio upload widget');
    expect(tool.description).toContain('does not accept video files');
    expect(tool.description).not.toContain('Never');
    expect(tool.resultFormat).toBe('mcp');
    expect(tool.outputSchema).toMatchObject({
      requestedMediaType: expect.any(Object),
      script: expect.any(Object),
    });
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
      throw new Error('assets_open-upload-widget must return a raw MCP result');
    }
    const result = await tool.handler({
      requestedMediaType: 'image',
    });

    expect(result.structuredContent).toEqual({
      requestedMediaType: 'image',
    });
    expect(JSON.parse(JSON.stringify(result.structuredContent))).toEqual({
      requestedMediaType: 'image',
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
    });
  });

  it('does not accept video as a requested widget media type', async () => {
    const tool = createUploadWidgetTool();
    if (tool.resultFormat !== 'mcp') {
      throw new Error('assets_open-upload-widget must return a raw MCP result');
    }
    const result = await tool.handler({
      requestedMediaType: 'video',
    });

    expect(result.structuredContent).toEqual({});
  });
});

describe('UPLOAD_WIDGET_HTML', () => {
  it('uses ChatGPT file APIs and calls the assets_upload tool', () => {
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
    expect(UPLOAD_WIDGET_HTML).toContain('openai.callTool("assets_upload"');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.callTool("voices_list"');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.callTool("lipsync_create-from-assets"');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.callTool("generations_get"');
    expect(UPLOAD_WIDGET_HTML).toContain('id="scriptInput"');
    expect(UPLOAD_WIDGET_HTML).toContain('id="runLipsync"');
  });
});

// Runs the widget's own result readers, as the ChatGPT iframe would.
function widgetFunction(name: string): (value: unknown) => string {
  const source = ['parseJson', 'payloadFromToolResult', 'findStringByKeys', name]
    .map((fn) => {
      const start = UPLOAD_WIDGET_HTML.indexOf(`        function ${fn}(`);
      const end = UPLOAD_WIDGET_HTML.indexOf('\n        }\n', start);
      if (start < 0 || end < 0) throw new Error(`The widget has no function ${fn}`);
      return UPLOAD_WIDGET_HTML.slice(start, end + 10);
    })
    .join('\n');
  return runInNewContext(`${source}\n${name}`) as (value: unknown) => string;
}

describe('widget generation result', () => {
  const outputUrlFrom = widgetFunction('outputUrlFrom');
  const url = 'https://fixture.invalid/result.mp4?Signature=a%2Fb';

  it('reads the API name outputMediaUrl and the older outputUrl and output_url', () => {
    for (const key of ['outputMediaUrl', 'outputUrl', 'output_url'])
      expect(outputUrlFrom({ structuredContent: { status: 'COMPLETED', [key]: url } }), key).toBe(
        url,
      );
    expect(
      outputUrlFrom({ content: [{ type: 'text', text: JSON.stringify({ outputMediaUrl: url }) }] }),
    ).toBe(url);
    expect(outputUrlFrom({ structuredContent: { status: 'PENDING' } })).toBe('');
  });

  it('prefers outputMediaUrl when both names are present', () => {
    expect(
      outputUrlFrom({
        structuredContent: { outputUrl: 'https://old.invalid', outputMediaUrl: url },
      }),
    ).toBe(url);
  });

  it('tells the model the API name', () => {
    expect(UPLOAD_WIDGET_HTML).toContain('"; outputMediaUrl: " + outputUrl');
    expect(UPLOAD_WIDGET_HTML).not.toContain('"; outputUrl: "');
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
      'sync-upload-widget-v8',
      'sync-upload-widget-v1',
      'sync-upload-widget-v2',
      'sync-upload-widget-v3',
      'sync-upload-widget-v4',
      'sync-upload-widget-v5',
      'sync-upload-widget-v6',
      'sync-upload-widget-v7',
    ]);

    const legacyRegistration = registrations.find(
      (registration) => registration.uri === 'ui://sync/upload-widget-v6.html',
    );
    // The widget read ignores the request context; only its shape is required.
    const ctx = {
      mcpReq: { id: 1, signal: new AbortController().signal },
    } as unknown as Parameters<ReadResourceCallback>[1];
    const result = (await legacyRegistration?.readCallback(
      new URL('ui://sync/upload-widget-v6.html'),
      ctx,
    )) as ReadResourceResult | undefined;

    expect(result?.contents[0]).toMatchObject({
      uri: 'ui://sync/upload-widget-v6.html',
      text: UPLOAD_WIDGET_HTML,
    });
  });
});
