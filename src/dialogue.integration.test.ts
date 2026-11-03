import { afterEach, expect, it } from 'vitest';
import {
  closeDialogueFixtures,
  dialogueFixture as fixture,
  projectId,
  videoAssetId,
  transcriptionId,
  dialogueEditId,
  uploadedAssetId,
  externalUrl,
  source,
  sourceVideoUrl,
  transcript,
  edits,
  estimate,
} from './test-fixtures/dialogue.js';
import { routeUploadSourceToFixture } from './test-fixtures/upload-source.js';

afterEach(closeDialogueFixtures);
it.each([false, true])(
  'advertises account-scoped dialogue writes with keyedPreview=%s',
  async (keyedPreview) => {
    const { client } = await fixture({ keyedPreview });
    const tools = (await client.listTools()).tools;
    for (const name of ['create-dialogue-preview', 'create-dialogue-video']) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
      expect(tool?._meta?.['openai/widgetAccessible']).toBe(true);
      expect(tool?._meta?.ui).toMatchObject({ visibility: ['model', 'app'] });
      expect(tool?.inputSchema.required).toEqual(
        expect.arrayContaining(['projectId', 'videoAssetId']),
      );
      expect(tool?.inputSchema.properties).not.toHaveProperty('sourceVideoUrl');
      expect(tool?.inputSchema.properties).not.toHaveProperty('voiceId');
    }
    // Copying a saved external source can still fetch an open-world URL.
    expect(
      tools.find((tool) => tool.name === 'upload-dialogue-source')?.annotations?.openWorldHint,
    ).toBe(true);
  },
);
it.each([undefined, 'COMPLETED', 'COMPLETED_PARTIAL'] as const)(
  'transcribes, preserves preview quality (%s), estimates and submits the canonical preview through MCP',
  async (previewStatus) => {
    const partialDetail = previewStatus
      ? { slotsTotal: 1, slotsOk: 0, failedSlots: [{ index: 0, errorCode: 'QC_SEAM_STEP' }] }
      : undefined;
    const { calls, client, call } = await fixture({ previewStatus, partialDetail });
    const tools = (await client.listTools()).tools;
    expect(
      tools.find((tool) => tool.name === 'create-dialogue-preview')?._meta?.[
        'openai/widgetAccessible'
      ],
    ).toBe(true);
    for (const tool of tools.filter((candidate) => candidate.name.includes('dialogue')))
      expect(tool.title, tool.name).toBeTruthy();
    expect((await call('create-dialogue-transcription', source)).isError).not.toBe(true);
    expect(calls.find((c) => c.path === '/v2/transcriptions')?.body).toEqual({
      sourceVideoUrl,
      projectId,
      maxSourceSeconds: 600,
    });
    const preview = await call('create-dialogue-preview', { ...source, transcriptionId, edits });
    expect(preview.isError).not.toBe(true);
    const recovered = await call('get-dialogue-preview', { ...source, id: dialogueEditId });
    expect(recovered.isError).not.toBe(true);
    for (const result of [preview, recovered]) {
      if (partialDetail)
        expect(result.structuredContent).toMatchObject({ status: previewStatus, partialDetail });
      else expect(result.structuredContent).not.toHaveProperty('partialDetail');
    }
    expect(calls.find((c) => c.path === '/v2/dialogue-edits')?.body).toEqual({
      sourceVideoUrl,
      projectId,
      transcript,
      edits,
      transcriptionJobId: transcriptionId,
    });
    const input = {
      ...source,
      dialogueEditId,
      model: 'sync-3',
      options: { active_speaker_detection: true },
    };
    expect((await call('estimate-dialogue-video', input)).structuredContent).toEqual(estimate);
    expect(
      (await call('create-dialogue-video', { ...input, idempotencyKey: 'dialogue-request' }))
        .isError,
    ).not.toBe(true);
    const generation = calls.find((c) => c.path === '/v2/generate')!;
    expect(generation.body).toEqual({
      projectId,
      model: 'sync-3',
      input: [{ type: 'video', assetId: videoAssetId }],
      dialogueEdit: { id: dialogueEditId },
      options: { active_speaker_detection: { auto_detect: true } },
    });
    expect(calls.find((c) => c.path === '/v2/analyze/cost')?.body).toEqual(generation.body);
    expect(generation.key).toBe('dialogue-request');
    expect(calls.every((c) => c.token === 'Bearer dialogue-reader')).toBe(true);
  },
);
it.each([{ denied: true }, { mismatched: true }])(
  'blocks preview creation for inaccessible or different source: %j',
  async (options) => {
    const { call, calls } = await fixture(options);
    expect(
      (await call('create-dialogue-preview', { ...source, transcriptionId, edits })).isError,
    ).toBe(true);
    expect(calls.some((c) => c.path === '/v2/dialogue-edits')).toBe(false);
  },
);
it('does not retry an ambiguous paid preview and reuses the original voice without false rerun lineage', async () => {
  const { call, calls } = await fixture({ lostPreview: true });
  expect(
    (
      await call('create-dialogue-preview', {
        ...source,
        previousPreviewId: dialogueEditId,
        edits: [{ kind: 'change', wordId: 'w1', replacement: 'Welcome' }],
      })
    ).isError,
  ).toBe(true);
  const writes = calls.filter((c) => c.path === '/v2/dialogue-edits');
  expect(writes).toHaveLength(1);
  expect(writes[0]?.body?.voiceId).toBe('original-speaker');
  expect(writes[0]?.body).not.toHaveProperty('rerunOfJobId');
});

it('rejects ambiguous transcript identity before any preview synthesis', async () => {
  const { call, calls } = await fixture();
  const response = await call('create-dialogue-preview', {
    ...source,
    transcriptionId,
    previousPreviewId: dialogueEditId,
    edits,
  });
  expect(response.isError).toBe(true);
  expect(calls.some((request) => request.path === '/v2/dialogue-edits')).toBe(false);
});

it('forwards one frozen keyed preview through explicit recovery even when asset playback signatures rotate', async () => {
  const { call, calls } = await fixture({
    keyedPreview: true,
    rotatingAssetUrl: true,
    lostPreview: true,
  });
  const request = {
    ...source,
    transcriptionId,
    edits,
    idempotencyKey: 'dialogue-preview-recovery',
  };
  expect((await call('create-dialogue-preview', request)).isError).toBe(true);
  expect(calls.filter((c) => c.path === '/v2/dialogue-edits')).toHaveLength(1);
  expect((await call('create-dialogue-preview', request)).isError).toBe(true);
  const writes = calls.filter((c) => c.path === '/v2/dialogue-edits');
  expect(writes).toHaveLength(2);
  expect(writes.map((c) => c.key)).toEqual([
    'dialogue-preview-recovery',
    'dialogue-preview-recovery',
  ]);
  expect(writes[0]!.body).toEqual({
    sourceVideoUrl,
    projectId,
    transcript,
    edits,
    transcriptionJobId: transcriptionId,
  });
  expect(writes[1]!.body).toEqual(writes[0]!.body);
  expect((await call('get-dialogue-options', {})).structuredContent).toMatchObject({
    keyedPreview: true,
  });
});
it('refuses keyed preview admission when the upstream has no idempotency contract', async () => {
  const { call, calls } = await fixture();
  expect(
    (
      await call('create-dialogue-preview', {
        ...source,
        transcriptionId,
        edits,
        idempotencyKey: 'unsupported-recovery',
      })
    ).isError,
  ).toBe(true);
  expect(calls.some((c) => c.path === '/v2/dialogue-edits')).toBe(false);
  expect((await call('get-dialogue-options', {})).structuredContent).toMatchObject({
    keyedPreview: false,
  });
});

it('copies an external dialogue source when transcription asks and uses the copy through generation', async () => {
  const { calls, call, port } = await fixture({ external: true });
  const transport = routeUploadSourceToFixture(port);
  try {
    const transcription = await call('create-dialogue-transcription', source);
    expect(transcription.isError).not.toBe(true);
    expect(transcription.structuredContent).toMatchObject({ videoAssetId: uploadedAssetId });
    const hosted = { projectId, videoAssetId: uploadedAssetId };
    expect(
      (await call('get-dialogue-transcription', { ...hosted, id: transcriptionId })).isError,
    ).not.toBe(true);
    expect(
      (await call('create-dialogue-preview', { ...hosted, transcriptionId, edits })).isError,
    ).not.toBe(true);
    expect(
      (
        await call('create-dialogue-video', {
          ...hosted,
          dialogueEditId,
          model: 'sync-3',
          idempotencyKey: 'external-dialogue',
        })
      ).isError,
    ).not.toBe(true);
    expect(calls.find((c) => c.path === '/storage')?.body).toEqual({
      bytes: 'external video bytes',
    });
    expect(calls.find((c) => c.path === '/v2/assets')?.body).toMatchObject({
      url: sourceVideoUrl,
      type: 'VIDEO',
      projectId,
    });
    expect(
      calls.filter((c) => c.path === '/v2/transcriptions').map((c) => c.body?.sourceVideoUrl),
    ).toEqual([externalUrl, sourceVideoUrl]);
    expect(calls.findIndex((c) => c.path === '/storage')).toBeLessThan(
      calls.findIndex((c) => c.path === '/v2/assets'),
    );
    expect(calls.find((c) => c.path === '/v2/generate')?.body?.input).toEqual([
      { type: 'video', assetId: uploadedAssetId },
    ]);
    expect(
      calls
        .filter((c) => c.path.startsWith('/v2/'))
        .every((c) => c.token === 'Bearer dialogue-reader'),
    ).toBe(true);
  } finally {
    transport.restore();
  }
});
it('names the saved copy when transcribing it fails, so a retry does not copy again', async () => {
  const { calls, call, port } = await fixture({ external: true, hostedTranscriptionFails: true });
  const transport = routeUploadSourceToFixture(port);
  try {
    const result = await call('create-dialogue-transcription', source);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(`videoAssetId ${uploadedAssetId}`);
    expect(calls.filter((c) => c.path === '/storage')).toHaveLength(1);
  } finally {
    transport.restore();
  }
});
it('does not save an external dialogue source when storage rejects its upload', async () => {
  const { calls, call, port } = await fixture({ external: true, uploadRejected: true });
  const transport = routeUploadSourceToFixture(port);
  try {
    expect((await call('upload-dialogue-source', source)).isError).toBe(true);
    expect(calls.some((c) => c.path === '/storage')).toBe(true);
    expect(calls.some((c) => c.path === '/v2/assets' || c.path === '/v2/transcriptions')).toBe(
      false,
    );
  } finally {
    transport.restore();
  }
});
it('checks source access before downloading an external dialogue video', async () => {
  const { calls, call } = await fixture({ external: true, denied: true });
  expect((await call('upload-dialogue-source', source)).isError).toBe(true);
  expect(calls.some((c) => c.path === '/external.mp4' || c.path === '/v2/assets/upload')).toBe(
    false,
  );
});

it('shows agents the edit shapes and rejects a malformed edit before any write', async () => {
  const { calls, client, call } = await fixture();
  const preview = (await client.listTools()).tools.find(
    (tool) => tool.name === 'create-dialogue-preview',
  );
  if (!preview) throw new Error('create-dialogue-preview is not listed');
  const properties = preview.inputSchema.properties as Record<string, { items?: unknown }>;
  const items = JSON.stringify(properties.edits?.items);
  for (const field of ['"change"', '"remove"', '"replacement"', '"wordIds"'])
    expect(items).toContain(field);
  const result = await call('create-dialogue-preview', {
    ...source,
    transcriptionId,
    edits: [{ kind: 'change', wordId: 'w1' }],
  });
  expect(result.isError).toBe(true);
  expect(calls.some((c) => c.path === '/v2/dialogue-edits')).toBe(false);
});
