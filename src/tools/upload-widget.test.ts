import { describe, expect, it } from 'vitest';
import { createUploadWidgetTool, UPLOAD_WIDGET_HTML, UPLOAD_WIDGET_URI } from './upload-widget.js';

describe('createUploadWidgetTool', () => {
  it('declares the ChatGPT render template metadata', () => {
    const tool = createUploadWidgetTool();

    expect(tool.name).toBe('open-upload-widget');
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
      script: 'hello from tests',
    });

    expect(result.structuredContent).toEqual({
      requestedMediaType: 'image',
      script: 'hello from tests',
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
    });
  });
});

describe('UPLOAD_WIDGET_HTML', () => {
  it('uses ChatGPT file APIs and calls the upload-media tool', () => {
    expect(UPLOAD_WIDGET_HTML).toContain('openai.selectFiles');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.uploadFile');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.getFileDownloadUrl');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.callTool("upload-media"');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.callTool("voices_get-voices"');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.callTool("create-lipsync"');
    expect(UPLOAD_WIDGET_HTML).toContain('openai.callTool("generate_get-generation"');
  });
});
