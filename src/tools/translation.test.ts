import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../http-client.js';
import { ApiRequestError } from '../http-client.js';
import { parseSpec } from '../openapi/parser.js';
import { projectId, translationInput, translationSpec } from '../test-fixtures/translation.js';
import { createTranslationTools } from './translation.js';

function fixture(request = vi.fn<HttpClient['request']>(async () => ({ id: projectId }))) {
  const tool = createTranslationTools(parseSpec(translationSpec), { request })[0]!;
  return { tool, request };
}

describe('combined translation generation', () => {
  it('discovers API-supported languages without submitting or probing an account', async () => {
    const request = vi.fn();
    const options = createTranslationTools(parseSpec(translationSpec), { request }).find(
      (tool) => tool.name === 'get-translation-options',
    );
    expect(options).toBeDefined();
    expect(await options!.handler({})).toEqual({
      targetLanguages: ['es', 'fr', 'ja'],
      sourceLanguages: ['auto', 'en', 'es', 'fr', 'ja'],
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('submits one saved video with canonical dubbing parameters and a stable key', async () => {
    const { tool, request } = fixture();
    const signal = new AbortController().signal;
    await tool.handler(
      {
        ...translationInput,
        sourceLang: 'en',
        options: { reasoning_enabled: true, active_speaker_detection: true },
      },
      { signal },
    );
    expect(request.mock.calls).toEqual([
      ['get', `/v2/projects/${projectId}`, { signal }],
      [
        'post',
        '/v2/generate',
        {
          signal,
          headers: { 'Idempotency-Key': 'translation-test-1' },
          body: {
            model: 'sync-3',
            projectId,
            input: [{ type: 'video', assetId: translationInput.videoAssetId }],
            dubParams: { targetLang: 'es', sourceLang: 'en' },
            options: { reasoning_enabled: true, active_speaker_detection: { auto_detect: true } },
          },
        },
      ],
    ]);
  });

  it.each([
    { targetLang: 'unsupported' },
    { sourceLang: 'unsupported' },
    { targetLang: undefined },
    { videoAssetId: 'not-an-asset' },
    { projectId: '' },
    { model: '' },
    { idempotencyKey: undefined },
    { idempotencyKey: 'bad key' },
    { audioAssetId: translationInput.videoAssetId },
    { videoUrl: 'https://example.com/video.mp4' },
    { options: { internal_only: true } },
  ])('rejects invalid or conflicting inputs before any request: %j', async (patch) => {
    const { tool, request } = fixture();
    await expect(tool.handler({ ...translationInput, ...patch })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { id: 'another-project' },
  ])('refuses an unverified project: %j', async (response) => {
    const { tool, request } = fixture(vi.fn(async () => response));
    await expect(tool.handler(translationInput)).rejects.toThrow('verify access');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404])('does not submit when project access fails with %s', async (status) => {
    const failure = new ApiRequestError('Not accessible', status);
    const { tool, request } = fixture(
      vi.fn(async () => {
        throw failure;
      }),
    );
    await expect(tool.handler(translationInput)).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    402, 409, 503,
  ])('preserves a rejected or ambiguous create outcome without an implicit retry: %s', async (status) => {
    const failure = new ApiRequestError(
      'Submission uncertain',
      status,
      'IDEMPOTENCY_OUTCOME_UNKNOWN',
      2000,
      'known-generation',
    );
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce({ id: projectId })
      .mockRejectedValueOnce(failure);
    const { tool } = fixture(request);
    await expect(tool.handler(translationInput)).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps the same key and body when the caller explicitly retries a lost response', async () => {
    const writes: unknown[] = [];
    const request = vi.fn<HttpClient['request']>(async (method, _path, options) => {
      if (method === 'get') return { id: projectId };
      writes.push(options);
      if (writes.length === 1) throw new Error('Response lost');
      return { id: 'existing-generation', status: 'PROCESSING' };
    });
    const { tool } = fixture(request);
    await expect(tool.handler(translationInput)).rejects.toThrow('Response lost');
    expect(writes).toHaveLength(1);
    await expect(tool.handler(translationInput)).resolves.toEqual({
      id: 'existing-generation',
      status: 'PROCESSING',
    });
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
  });

  it('does not create after cancellation during the access check', async () => {
    const controller = new AbortController();
    const { tool, request } = fixture(
      vi.fn(async () => {
        controller.abort();
        return { id: projectId };
      }),
    );
    await expect(tool.handler(translationInput, { signal: controller.signal })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not advertise translation when the upstream contract is missing', () => {
    expect(createTranslationTools([], { request: vi.fn() })).toEqual([]);
    const operations = parseSpec(translationSpec);
    operations.find((operation) => operation.path === '/v2/generate')!.requestBody!.schema = {};
    expect(createTranslationTools(operations, { request: vi.fn() })).toEqual([]);
  });
});
