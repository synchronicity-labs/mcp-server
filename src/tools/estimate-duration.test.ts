import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ParsedOperation } from '../openapi/types.js';
import { registerTools } from '../server.js';
import { resolveEstimateDuration } from './estimate-duration.js';
import { generateTools } from './generator.js';

const script = 'Hi Anchit, how are you today';

describe('replacement speech estimates', () => {
  it('quotes the short replacement script instead of the 30-second video', () => {
    expect(resolveEstimateDuration({ model: 'sync-3', duration: 30.03, script })).toEqual({
      args: { model: 'sync-3', duration: 2.25 },
      durationEstimate: {
        durationSeconds: 2.25,
        audioDurationSeconds: 2.25,
        source: 'script',
        approximate: true,
        excludesSpeechSynthesis: true,
      },
    });
  });

  it('uses measured audio when available, preserving fractional seconds', () => {
    expect(resolveEstimateDuration({ duration: 30.03, script, audioDuration: 2.73 })).toEqual({
      args: { duration: 2.73 },
      durationEstimate: {
        durationSeconds: 2.73,
        audioDurationSeconds: 2.73,
        source: 'audio',
        approximate: false,
        excludesSpeechSynthesis: true,
      },
    });
  });

  it.each([
    ['bounce', 40, 30, 40],
    ['loop', 2.5, 30, 2.5],
    ['remap', 2.5, 30, 2.5],
    ['cut_off', 40, 30, 30],
    ['cut_off', 2.5, 30, 2.5],
    ['silence', 2.5, 30, 30],
    ['silence', 40, 30, 40],
  ])('prices %s output for %ss audio and %ss video', (syncMode, audio, video, expected) => {
    expect(
      resolveEstimateDuration({ audioDuration: audio, videoDuration: video, syncMode }).args
        .duration,
    ).toBe(expected);
  });

  it('supports image-to-video estimates without a video duration', () => {
    expect(resolveEstimateDuration({ audioDuration: 3.5 }).args.duration).toBe(3.5);
  });

  it.each(['cut_off', 'silence'])('prices image input with %s by speech duration', (syncMode) => {
    expect(
      resolveEstimateDuration({ visualType: 'image', audioDuration: 3.5, syncMode }).args,
    ).toEqual({ duration: 3.5 });
    expect(resolveEstimateDuration({ visualType: 'image', script, syncMode }).args).toEqual({
      duration: 2.25,
    });
  });

  it('refuses contradictory image and video inputs', () => {
    expect(() =>
      resolveEstimateDuration({ visualType: 'image', audioDuration: 2.5, videoDuration: 30 }),
    ).toThrow(/Omit videoDuration/);
  });

  it('counts speech without whitespace and long unspaced text', () => {
    expect(resolveEstimateDuration({ script: '你好世界' }).args.duration).toBe(1.5);
    expect(resolveEstimateDuration({ script: 'a'.repeat(160) }).args.duration).toBe(10);
  });

  it.each(['', '   ', '!!!'])('refuses a non-spoken script: %j', (text) => {
    expect(() => resolveEstimateDuration({ script: text })).toThrow();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses invalid measured duration %s',
    (audioDuration) => {
      expect(() => resolveEstimateDuration({ audioDuration })).toThrow();
    },
  );

  it.each(['cut_off', 'silence'])('requires video length for %s quotes', (syncMode) => {
    expect(() => resolveEstimateDuration({ audioDuration: 2.5, syncMode })).toThrow(
      /videoDuration/,
    );
    expect(() =>
      resolveEstimateDuration({ visualType: 'video', audioDuration: 2.5, syncMode }),
    ).toThrow(/videoDuration/);
  });

  it('keeps translation on its combined source-duration pricing path', () => {
    const args = { duration: 30, workflow: 'translate-and-dub' };
    expect(resolveEstimateDuration(args)).toEqual({ args, durationEstimate: undefined });
    expect(() => resolveEstimateDuration({ ...args, script })).toThrow(/Translation/);
  });

  it('preserves existing explicit output-duration estimates', () => {
    const args = { model: 'sync-3', duration: 30.03, fps: 25, reasoningEnabled: true };
    expect(resolveEstimateDuration(args)).toEqual({ args, durationEstimate: undefined });
  });
});

describe.each([
  ['GenerateController_estimateCost', '/v2/generate/estimate-cost'],
  ['GenerationsController_estimateCost', '/v2/generations/estimate'],
])('%s tool', (operationId, path) => {
  const operation: ParsedOperation = {
    operationId,
    path,
    method: 'post',
    summary: 'Estimate cost',
    tags: ['Generate'],
    parameters: [],
    isMultipart: false,
    requestBody: {
      contentType: 'application/json',
      schema: {
        type: 'object',
        properties: {
          model: { type: 'string' },
          duration: { type: 'number' },
          fps: { type: 'number' },
          reasoningEnabled: { type: 'boolean' },
          workflow: { type: 'string' },
        },
        required: ['model', 'duration'],
      },
    },
  };

  it('accepts script without duration and forwards only resolved pricing inputs', async () => {
    const upstream = { estimatedGenerationCost: 0.29, estimatedCredits: null };
    const request = vi.fn().mockResolvedValue(upstream);
    const tool = generateTools([operation], { request })[0]!;
    const args = z.object(tool.inputSchema).parse({
      model: 'sync-3',
      script,
      fps: 25,
      reasoningEnabled: true,
    });
    const controller = new AbortController();
    const result = await tool.handler(args, { signal: controller.signal });
    expect(request).toHaveBeenCalledExactlyOnceWith('post', path, {
      query: undefined,
      body: { model: 'sync-3', duration: 2.25, fps: 25, reasoningEnabled: true },
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      ...upstream,
      durationEstimate: { durationSeconds: 2.25, source: 'script', approximate: true },
    });
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('advertises and returns speech-based quotes through the MCP protocol', async () => {
    const request = vi.fn().mockResolvedValue({ estimatedGenerationCost: 0.29 });
    const tools = generateTools([operation], { request });
    const toolName = tools[0]!.name;
    const server = new McpServer({ name: 'estimate-test', version: '1' });
    registerTools(server, tools);
    const client = new Client({ name: 'openai-mcp', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const descriptor = (await client.listTools()).tools.find((tool) => tool.name === toolName)!;
      expect(descriptor.inputSchema.required).not.toContain('duration');
      expect(descriptor.inputSchema.properties).toHaveProperty('script');
      const result = await client.callTool({
        name: toolName,
        arguments: { model: 'sync-3', script, duration: 30.03 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        estimatedGenerationCost: 0.29,
        durationEstimate: { durationSeconds: 2.25, source: 'script', approximate: true },
      });
      for (const syncMode of ['cut_off', 'silence']) {
        const imageResult = await client.callTool({
          name: toolName,
          arguments: { model: 'sync-3', visualType: 'image', audioDuration: 3.5, syncMode },
        });
        expect(imageResult.isError).not.toBe(true);
        expect(imageResult.structuredContent).toMatchObject({
          durationEstimate: { durationSeconds: 3.5, source: 'audio', approximate: false },
        });
        expect(request.mock.lastCall?.[2].body).toEqual({ model: 'sync-3', duration: 3.5 });
      }
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[0]?.[2].body).toEqual({ model: 'sync-3', duration: 2.25 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects missing duration before calling the API', async () => {
    const request = vi.fn();
    const tool = generateTools([operation], { request })[0]!;
    await expect(tool.handler({ model: 'sync-3' })).rejects.toThrow(/duration/);
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves ordinary quotes and their response', async () => {
    const upstream = { estimatedCredits: 100, breakdown: { lipsync: {} } };
    const request = vi.fn().mockResolvedValue(upstream);
    const tool = generateTools([operation], { request })[0]!;
    const args = { model: 'sync-3', duration: 30, workflow: 'translate-and-dub' };
    expect(await tool.handler(args)).toEqual(upstream);
    expect(request).toHaveBeenCalledExactlyOnceWith('post', path, {
      query: undefined,
      body: args,
      signal: undefined,
    });
  });
});
