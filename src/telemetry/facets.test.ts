import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiRequestError } from '../http-client.js';
import {
  argumentFacets,
  classifyOutcome,
  invalidFields,
  resultFacets,
  textBucket,
  urlClass,
} from './facets.js';

const uuid = '0b6c6a1e-3c5e-4a51-9f0e-4b7c2b1d9a10';

describe('argument facets', () => {
  const shape = {
    model: z.enum(['lipsync-2', 'lipsync-2-pro']),
    videoUrl: z.url().optional(),
    videoAssetId: z.uuid().optional(),
    script: z.string().optional(),
    targetLanguage: z.string().optional(),
    targetLanguages: z.array(z.string()).optional(),
    temperature: z.number().optional(),
    reasoning: z.boolean().optional(),
    segments: z.array(z.object({ start: z.number() })).optional(),
    options: z.object({ x: z.string() }).optional(),
  };

  it('keeps closed-set values and reduces open text to its kind', () => {
    expect(
      argumentFacets(shape, {
        model: 'lipsync-2-pro',
        videoUrl: 'https://www.youtube.com/watch?v=secret',
        videoAssetId: uuid,
        script: 'Hello, my name is Jane and my card is 4242',
        targetLanguage: 'pt-BR',
        targetLanguages: ['fr', 'es', 'fr'],
        temperature: 0.12345,
        reasoning: true,
        segments: [{ start: 1 }, { start: 2 }],
        options: { x: 'private' },
        undeclared: 'never read',
      }),
    ).toEqual({
      model: 'lipsync-2-pro',
      videoUrl: 'url:youtube',
      videoAssetId: 'uuid',
      script: 'text:21-100',
      targetLanguage: 'pt-BR',
      targetLanguages: 'es,fr',
      temperature: 0.123,
      reasoning: true,
      segments: 'array:2',
      options: 'object',
    });
  });

  it('never records a value outside the schema’s closed set', () => {
    const facets = argumentFacets(shape, {
      model: 'something else entirely',
      targetLanguage: 'Spanish, but make it sound like my boss',
      videoUrl: 'https://intranet.acme-corp.example/q3-layoffs.mp4?sig=abc',
      script: '/Users/jane/Desktop/interview.mov',
    });
    expect(facets).toEqual({
      model: 'text:21-100',
      targetLanguage: 'text:21-100',
      videoUrl: 'url:other',
      script: 'path',
    });
  });

  it('keeps product identifiers the API types as free text, but not sentences', () => {
    const open = { model: z.string(), voiceId: z.string(), status: z.string() };
    expect(
      argumentFacets(open, { model: 'lipsync-2-pro', voiceId: 'EXAVITQu4vr4xnSDxMaL' }),
    ).toEqual({
      model: 'lipsync-2-pro',
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
    });
    expect(argumentFacets(open, { model: 'the best one please', status: 'done!' })).toEqual({
      model: 'text:1-20',
      status: 'text:1-20',
    });
  });

  it('names the declared fields that failed validation', () => {
    expect(invalidFields(shape, { model: 'nope', videoAssetId: 'x', extra: 1 }).sort()).toEqual([
      'model',
      'videoAssetId',
    ]);
  });
});

describe('url classes and text buckets', () => {
  it.each([
    ['https://youtu.be/abc', 'url:youtube'],
    ['https://vm.tiktok.com/x', 'url:tiktok'],
    ['https://cdn.sync.so/a.mp4', 'url:sync'],
    ['https://files.oaiusercontent.com/f', 'url:openai_file'],
    ['https://bucket.s3.us-east-1.amazonaws.com/k', 'url:s3'],
    ['https://notyoutube.com/x', 'url:other'],
    ['file:///tmp/a.mp4', 'path'],
    ['data:audio/wav;base64,AAAA', 'url:data'],
    ['not a url', undefined],
  ])('%s → %s', (value, expected) => {
    expect(urlClass(value)).toBe(expected);
  });

  it('buckets lengths', () => {
    expect([1, 20, 21, 500, 501, 2001].map(textBucket)).toEqual([
      'text:1-20',
      'text:1-20',
      'text:21-100',
      'text:101-500',
      'text:501-2000',
      'text:2001+',
    ]);
  });
});

describe('result facets', () => {
  it('reads ids, status and list size, nothing else', () => {
    expect(
      resultFacets('lipsync_create', {
        id: uuid,
        status: 'PROCESSING',
        outputUrl: 'https://cdn/x',
        projectId: uuid,
      }),
    ).toEqual({ generation_id: uuid, project_id: uuid, result_status: 'PROCESSING' });
    expect(
      resultFacets('assets_list', { structuredContent: { items: [{ name: 'a' }, { name: 'b' }] } }),
    ).toEqual({ result_count: 2 });
    expect(resultFacets('voices_list', [1, 2, 3])).toEqual({ result_count: 3 });
    expect(resultFacets('assets_get', { id: uuid, status: 'Not a status!' })).toEqual({});
  });
});

describe('outcomes', () => {
  it('classifies without reading messages', () => {
    expect(classifyOutcome(undefined, { ok: true })).toEqual({ outcome: 'success' });
    expect(
      classifyOutcome(undefined, {
        isError: true,
        structuredContent: { error: { status: 402, code: 'plan_required', message: 'x' } },
      }),
    ).toEqual({ outcome: 'api_error', error_status: 402, error_code: 'plan_required' });
    expect(
      classifyOutcome(
        new ApiRequestError('local check', 400, 'PROJECT_INTENT_REQUIRED'),
        undefined,
      ),
    ).toEqual({
      outcome: 'refused',
      error_status: 400,
      error_code: 'PROJECT_INTENT_REQUIRED',
    });
    expect(classifyOutcome(new Error('Open the Sync app'), undefined)).toEqual({
      outcome: 'refused',
    });
    expect(classifyOutcome(new TypeError('x is undefined'), undefined)).toEqual({
      outcome: 'tool_error',
    });
    const timeout = new DOMException('late', 'TimeoutError');
    expect(classifyOutcome(timeout, undefined)).toEqual({ outcome: 'timeout' });
    const controller = new AbortController();
    controller.abort();
    expect(
      classifyOutcome(new DOMException('x', 'AbortError'), undefined, controller.signal),
    ).toEqual({
      outcome: 'cancelled',
    });
    expect(classifyOutcome(z.string().safeParse(1).error, undefined)).toEqual({
      outcome: 'invalid_arguments',
    });
  });
});
