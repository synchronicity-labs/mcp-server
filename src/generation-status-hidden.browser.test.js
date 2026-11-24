import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { expect as browserExpect, chromium } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import { createMcpServerFactory } from './server.js';
import { mountCard } from './test-fixtures/card-host-page.js';
import { estimateFrom } from './test-fixtures/status-card-estimate.js';

afterEach(() => vi.unstubAllGlobals());

const generationId = '00000000-0000-4000-8000-000000000004';
const projectId = '00000000-0000-4000-8000-000000000001';

// ChatGPT hides a card when the chat scrolls past it or the tab goes to the background.
// The packaged card has to keep checking at the slower hidden pace until the generation
// is final, and stop once it has outlived its support time.
async function withHiddenCard(generation, run) {
  const state = { current: generation, reads: [] };
  const directory = await mkdtemp(join(tmpdir(), 'sync-status-hidden-'));
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
    if (pathname === '/v2/generate') return Response.json(state.current);
    if (pathname === `/v2/projects/${projectId}`) return Response.json({ id: projectId });
    if (pathname === `/v2/generate/${generationId}`) {
      state.reads.push(state.current.status);
      return Response.json(state.current);
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
    const card = page.frames().find((candidate) => candidate !== page.mainFrame());
    const setHidden = (hidden) =>
      card.evaluate((value) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => (value ? 'hidden' : 'visible'),
        });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
    await run({ state, page, frame, setHidden });
    expect(pageErrors).toEqual([]);
  } finally {
    await browser.close();
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it('keeps checking a hidden card every 45 seconds until the generation completes', async () => {
  await withHiddenCard(
    { id: generationId, projectId, status: 'PROCESSING', model: 'sync-3' },
    async ({ state, page, frame, setHidden }) => {
      const badge = frame.locator('output[aria-live="polite"]');
      await browserExpect(badge).toHaveText('Processing');
      await setHidden(true);
      const hiddenAt = state.reads.length;
      // Hidden, the card waits longer than the 10 second visible pace.
      await page.clock.fastForward(30000);
      expect(state.reads).toHaveLength(hiddenAt);
      state.current = {
        ...state.current,
        status: 'COMPLETED',
        outputUrl: 'https://fixture.invalid/result.mp4',
        outputMediaUrl: 'https://fixture.invalid/result.mp4',
      };
      await page.clock.fastForward(16000);
      await browserExpect(badge).toHaveText('Completed');
      expect(state.reads.at(-1)).toBe('COMPLETED');
      // Final: no further reads, hidden or not.
      const settled = state.reads.length;
      await page.clock.fastForward(120000);
      await setHidden(false);
      await page.clock.fastForward(30000);
      expect(state.reads).toHaveLength(settled);
    },
  );
}, 30000);

it('stops checking a hidden card once the generation is past its support time', async () => {
  const serverNow = Date.parse('2026-11-24T12:00:00.000Z');
  await withHiddenCard(
    {
      id: generationId,
      projectId,
      status: 'PROCESSING',
      model: 'sync-3',
      // Estimated 25 minutes ago, so its support time passed five minutes ago.
      generationEstimate: {
        ...estimateFrom(serverNow - 1500000),
        serverTime: new Date(serverNow).toISOString(),
      },
    },
    async ({ state, page, frame, setHidden }) => {
      await browserExpect(frame.locator('output[aria-live="polite"]')).toHaveText('Processing');
      await setHidden(true);
      const hiddenAt = state.reads.length;
      await page.clock.fastForward(180000);
      expect(state.reads).toHaveLength(hiddenAt);
      // Shown again, the card checks at once.
      await setHidden(false);
      await browserExpect.poll(() => state.reads.length).toBeGreaterThan(hiddenAt);
    },
  );
}, 30000);
