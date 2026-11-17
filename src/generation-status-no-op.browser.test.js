import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { expect as browserExpect, chromium } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import { createMcpServerFactory } from './server.js';
import { mountCard } from './test-fixtures/card-host-page.js';

afterEach(() => vi.unstubAllGlobals());

// A NO_OP generation finished but lip-synced no frame, and its output is the unchanged
// input. The packaged card has to read it as final and unsuccessful, not as a result.
it('shows a generation that lip-synced no frame as unsuccessful, with the reason and no video', async () => {
  const generationId = '00000000-0000-4000-8000-000000000003';
  const projectId = '00000000-0000-4000-8000-000000000001';
  const reason = 'No face was found in the video, so nothing was lip-synced.';
  let current = { id: generationId, projectId, status: 'PENDING', model: 'sync-3' };
  const reads = [];
  const directory = await mkdtemp(join(tmpdir(), 'sync-status-no-op-'));
  const appHtml = '<html><body>Fixture Studio app</body></html>';
  await writeFile(join(directory, 'app.html'), appHtml);
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      version: 1,
      file: 'app.html',
      sha256: createHash('sha256').update(appHtml).digest('hex'),
    }),
  );
  vi.stubGlobal('fetch', async (input) => {
    const { pathname } = new URL(input);
    if (pathname === '/api-json')
      return Response.json({
        openapi: '3.0.0',
        paths: {
          '/v2/generate/{id}': {
            get: {
              operationId: 'GenerateController_getGeneration',
              tags: ['Generate'],
              parameters: [
                { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                {
                  name: 'include',
                  in: 'query',
                  required: false,
                  schema: { enum: ['progress'], type: 'string' },
                },
              ],
            },
          },
        },
      });
    if (pathname === '/v2/generate') return Response.json(current);
    if (pathname === `/v2/projects/${projectId}`) return Response.json({ id: projectId });
    if (pathname === `/v2/generate/${generationId}`) {
      reads.push(current.status);
      return Response.json(current);
    }
    return Response.json({}, { status: 404 });
  });
  const factory = await createMcpServerFactory({
    baseUrl: 'https://fixture.invalid',
    transport: 'http',
    port: 0,
    chatgptApp: {
      directory,
      domain: 'https://sync.fixture.invalid',
      resourceDomains: ['https://fixture.invalid'],
    },
  });
  const server = factory.createServer();
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const browser = await chromium.launch();
  try {
    const descriptor = (await client.listTools()).tools.find(
      (tool) => tool.name === 'lipsync_create',
    );
    const accepted = await client.callTool({
      name: descriptor.name,
      arguments: {
        projectId,
        projectIntent: 'explicit',
        videoAssetId: 'video-1',
        audioAssetId: 'audio-1',
      },
    });
    const resource = await client.readResource({ uri: descriptor._meta.ui.resourceUri });
    current = {
      ...current,
      status: 'NO_OP',
      outputUrl: 'https://fixture.invalid/unchanged-input.mp4',
      outputMediaUrl: 'https://fixture.invalid/unchanged-input.mp4',
      error: reason,
      errorCode: 'generation_lipsync_skipped_no_face',
    };
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.clock.install();
    await page.exposeFunction('canOpenSyncLink', () => true);
    await page.exposeFunction('callSync', (request) => client.callTool(request));
    await page.setContent(
      '<iframe title="Sync status" sandbox="allow-scripts allow-same-origin" style="border:0;width:100%;height:350px"></iframe>',
    );
    await page.evaluate(mountCard, {
      html: resource.contents[0].text,
      toolResult: accepted,
      hostBridge: 'standard',
      fontSources: resource.contents[0]._meta.ui.csp.resourceDomains,
    });
    const frame = page.frameLocator('iframe');
    await browserExpect(frame.locator('output[aria-live="polite"]')).toHaveText('No lip sync');
    await browserExpect(frame.getByRole('alert')).toContainText(reason);
    await browserExpect(frame.locator('video')).toHaveCount(0);
    await browserExpect(frame.getByRole('link', { name: 'View video' })).toHaveCount(0);
    // Final: the card stops checking instead of waiting for a status it knows.
    const settled = reads.length;
    await page.clock.fastForward(60000);
    expect(reads).toHaveLength(settled);
    expect(reads.at(-1)).toBe('NO_OP');
    expect(pageErrors).toEqual([]);
  } finally {
    await browser.close();
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
