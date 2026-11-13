import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { expect as browserExpect, chromium } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import { createMcpServerFactory } from './server.js';
import { mountCard } from './test-fixtures/card-host-page.js';

afterEach(() => vi.unstubAllGlobals());

// Exercise a served resource, real MCP tools and a browser host together. The API
// fixture never performs provider work; every status read must retain the one job.
it.each([
  ['standard', 'openai-mcp'],
  ['legacy', 'openai-mcp'],
  ['hybrid', 'openai-mcp'],
  ['no-media-policy', 'openai-mcp'],
  ['uncertain', 'openai-mcp'],
  ['legacy-uncertain', 'openai-mcp'],
  ['uncertain-text', 'openai-mcp'],
  ['legacy-uncertain-text', 'openai-mcp'],
  // Claude gets this card alone, over the standard MCP Apps bridge.
  ['standard', 'claude-ai'],
])(
  'checks one accepted job, its progress and server-clock ETA through the %s bridge as %s',
  async (bridge, clientName) => {
    const shot = clientName === 'openai-mcp' ? bridge : `claude-${bridge}`;
    const generationId = '00000000-0000-4000-8000-000000000003';
    const projectId = '00000000-0000-4000-8000-000000000001';
    const serverNow = Date.parse('2026-10-28T12:00:00Z');
    const estimate = {
      estimatedDurationSeconds: 125,
      estimatedAt: new Date(serverNow).toISOString(),
      calibrationAsOf: new Date(serverNow).toISOString(),
      supportAt: new Date(serverNow + 1200000).toISOString(),
      estimatorVersion: 'fixture',
      confidence: 'fallback',
      source: 'fallback',
      sampleCount: 0,
      scope: 'non_studio',
      durationBand: 'fixture',
      resolutionBand: 'fixture',
      resolutionSource: 'unknown',
      serverTime: new Date(serverNow).toISOString(),
      estimatedFinishAt: new Date(serverNow + 125000).toISOString(),
      delayedAt: new Date(serverNow + 600000).toISOString(),
    };
    const signedUrl = 'https://fixture.invalid/result.mp4?Signature=a%2Fb%2Bc&Expires=123';
    const thumbnailUrl = 'https://fixture.invalid/keynote.jpg';
    const inputVideoUrl = 'https://fixture.invalid/keynote.mp4';
    const summary = {
      title: 'Keynote in German',
      sourceLanguage: 'en',
      targetLanguage: 'de',
      duration: 42,
    };
    const still = { ...summary, preview: { type: 'image', url: thumbnailUrl } };
    let current = {
      id: generationId,
      projectId,
      status: 'PENDING',
      model: 'sync-3',
      generationEstimate: estimate,
    };
    // What the API adds to a read with include=progress; {} is an API that predates it.
    let display = { progress: { stage: 'queued' }, summary: still };
    let refused = false;
    let malformed = false;
    let refuseLinks = false;
    let holdRead = false;
    let releaseRead;
    const calls = [];
    const directory = await mkdtemp(join(tmpdir(), 'sync-status-release-'));
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
    vi.stubGlobal('fetch', async (input, init) => {
      const url = new URL(input);
      const path = url.pathname;
      if (path === '/api-json')
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
      calls.push({ path, method: init?.method });
      if (path === '/v2/generate' && bridge.includes('uncertain'))
        return Response.json(
          {
            message: 'Submission outcome is being reconciled',
            errorCode: 'IDEMPOTENCY_OUTCOME_UNKNOWN',
            generationId,
          },
          { status: 503 },
        );
      if (path === '/v2/generate')
        return Response.json({ ...current, status: 'PENDING', privateInput: 'hidden' });
      if (path === `/v2/projects/${projectId}`) return Response.json({ id: projectId });
      if (path === `/v2/generate/${generationId}`)
        return refused
          ? Response.json({ message: 'Access unavailable' }, { status: 403 })
          : Response.json(
              url.searchParams.get('include') === 'progress' ? { ...current, ...display } : current,
            );
      return Response.json({}, { status: 404 });
    });
    const factory = await createMcpServerFactory({
      baseUrl: 'https://fixture.invalid',
      transport: 'http',
      port: 0,
      ...(bridge === 'no-media-policy'
        ? {}
        : {
            chatgptApp: {
              directory,
              domain: 'https://sync.fixture.invalid',
              resourceDomains: ['https://fixture.invalid'],
            },
          }),
    });
    const server = factory.createServer();
    const client = new Client({ name: clientName, version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: bridge === 'standard' ? 360 : 720, height: 500 },
    });
    await context.route(/^https:\/\/(sync\.so|fixture\.invalid)\//, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Fixture destination</title>' }),
    );
    const videoBytes = await readFile(new URL('./test-fixtures/status-card.mp4', import.meta.url));
    await context.route(signedUrl, (route) =>
      route.request().resourceType() === 'media'
        ? route.fulfill({ contentType: 'video/mp4', body: videoBytes })
        : route.fulfill({ contentType: 'text/html', body: '<title>Fixture destination</title>' }),
    );
    const thumbnailBytes = await readFile(
      new URL('./test-fixtures/status-card-thumbnail.jpg', import.meta.url),
    );
    await context.route(thumbnailUrl, (route) =>
      route.fulfill({ contentType: 'image/jpeg', body: thumbnailBytes }),
    );
    await context.route(inputVideoUrl, (route) =>
      route.fulfill({ contentType: 'video/mp4', body: videoBytes }),
    );
    await context.tracing.start({ screenshots: true, snapshots: true });
    await mkdir('.cache/status-card', { recursive: true });
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
      expect(Boolean(accepted.isError)).toBe(bridge.includes('uncertain'));
      expect(accepted.structuredContent).toMatchObject(
        bridge.includes('uncertain')
          ? { error: { generationId } }
          : { id: generationId, projectId, generationEstimate: estimate },
      );
      expect(JSON.stringify(accepted)).not.toContain('privateInput');
      if (bridge === 'hybrid') holdRead = true;
      const delivered =
        bridge === 'hybrid'
          ? {
              ...accepted,
              structuredContent: {
                ...accepted.structuredContent,
                status: 'COMPLETED',
                outputUrl: signedUrl,
              },
            }
          : bridge.endsWith('-text')
            ? { ...accepted, structuredContent: undefined }
            : accepted;
      const resource = await client.readResource({ uri: descriptor._meta.ui.resourceUri });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      // Deliberately wrong local clock: ETA must follow the server's timestamp.
      await page.clock.install({ time: new Date('2040-01-01T00:00:00Z') });
      await page.exposeFunction('canOpenSyncLink', () => !refuseLinks);
      await page.exposeFunction('callSync', async (request) => {
        const result = await client.callTool(request);
        if (malformed) return { content: [], structuredContent: { id: generationId, status: 123 } };
        if (!holdRead) return result;
        holdRead = false;
        return new Promise((resolve) => {
          releaseRead = () => resolve(result);
        });
      });
      await page.setContent(
        '<iframe title="Sync status" sandbox="allow-scripts allow-same-origin" style="border:0;width:100%;height:350px"></iframe>',
      );
      await page.evaluate(mountCard, {
        html: resource.contents[0].text,
        toolResult: delivered,
        hostBridge: bridge,
        fontSources: resource.contents[0]._meta.ui.csp.resourceDomains,
      });
      const frame = page.frameLocator('iframe');
      await browserExpect.poll(() => page.evaluate(() => window.standardInitializes)).toBe(1);
      if (bridge.startsWith('legacy')) await page.clock.fastForward(4001);
      else
        await browserExpect.poll(() => page.evaluate(() => window.standardInitialized)).toBe(true);
      if (bridge === 'hybrid') {
        await browserExpect.poll(() => Boolean(releaseRead)).toBe(true);
        await browserExpect(frame.locator('video')).toHaveCount(0);
        releaseRead();
        releaseRead = undefined;
      }
      const badge = frame.locator('output[aria-live="polite"]');
      await browserExpect(badge).toHaveText('Queued');
      await browserExpect(frame.getByRole('heading', { name: 'Keynote in German' })).toBeVisible();
      await browserExpect(frame.getByLabel('Generation summary')).toHaveText(
        'English to German · 0:42 · sync-3',
      );
      // Queued work has no measured progress yet, so there is no bar to show.
      await browserExpect(frame.getByRole('progressbar')).toHaveCount(0);

      await browserExpect
        .poll(() =>
          frame.locator('body').evaluate(async () => {
            await document.fonts.ready;
            return [...document.fonts].some(
              (font) => font.family === 'Sync Satoshi' && font.status === 'loaded',
            );
          }),
        )
        .toBe(true);
      await browserExpect(frame.getByText('3 minutes remaining')).toBeVisible();
      const check = frame.getByRole('button', { name: 'Check status', exact: true });
      await browserExpect(check).toBeEnabled();
      // Without a media policy the host blocks the preview and the card keeps its placeholder.
      const loaded = (media, size) =>
        bridge === 'no-media-policy'
          ? browserExpect(frame.getByText('Preview unavailable', { exact: true })).toBeAttached()
          : browserExpect
              .poll(() => frame.locator(media).evaluate((element, key) => element[key], size))
              .toBeGreaterThan(0);
      await loaded('main img', 'naturalWidth');
      await frame.getByRole('main').screenshot({ path: `.cache/status-card/${shot}-pending.png` });
      current = { ...current, status: 'PROCESSING' };
      display = {
        progress: {
          stage: 'processing',
          percent: 40,
          completedTasks: 17,
          runningTasks: 4,
          waitingTasks: 22,
        },
        // An input without a thumbnail shows a frame of the video itself.
        summary: { ...summary, preview: { type: 'video', url: inputVideoUrl } },
      };
      await check.click();
      await browserExpect(badge).toHaveText('Processing');
      await browserExpect(frame.getByText('17 of 43 steps done')).toBeVisible();
      await browserExpect(frame.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
      await loaded('main video', 'videoWidth');
      await browserExpect(frame.getByRole('link', { name: 'Open in Sync' })).toHaveAttribute(
        'href',
        `https://sync.so/projects/${projectId}/studio?notification=generation&generationId=${generationId}`,
      );
      const studioOpened = context.waitForEvent('page');
      await frame.getByRole('link', { name: 'Open in Sync' }).click();
      const studioPage = await studioOpened;
      await studioPage.waitForURL(
        `https://sync.so/projects/${projectId}/studio?notification=generation&generationId=${generationId}`,
      );
      await studioPage.close();
      await page.clock.fastForward(6000);
      await browserExpect(frame.getByText('2 minutes remaining')).toBeVisible();
      await frame
        .getByRole('main')
        .screenshot({ path: `.cache/status-card/${shot}-processing.png` });
      const cardBounds = await frame.getByRole('main').boundingBox();
      expect(cardBounds.width).toBeLessThanOrEqual(bridge === 'standard' ? 360 : 720);
      const beforePoll = calls.length;
      current.generationEstimate = {
        ...estimate,
        serverTime: new Date(serverNow + 11000).toISOString(),
      };
      display = {
        ...display,
        progress: {
          stage: 'processing',
          percent: 70,
          completedTasks: 30,
          runningTasks: 4,
          waitingTasks: 9,
        },
      };
      await page.clock.fastForward(5000);
      await browserExpect.poll(() => calls.length).toBeGreaterThan(beforePoll);
      // The ten-second check alone moves the bar and the count; nobody clicked.
      await browserExpect(frame.getByText('30 of 43 steps done')).toBeVisible();
      await browserExpect(frame.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '70');
      // A later unrelated tool result cannot redirect the check action to another job.
      await page.evaluate(() =>
        document.querySelector('iframe').contentWindow.postMessage(
          {
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-result',
            params: { structuredContent: { id: 'other-job', status: 'COMPLETED' } },
          },
          '*',
        ),
      );
      refused = true;
      await check.click();
      await browserExpect(frame.getByRole('alert')).toContainText('Access unavailable');
      await browserExpect(check).toBeEnabled();
      await browserExpect(frame.locator('#estimate')).toBeHidden();
      refused = false;
      current = { id: generationId, projectId, status: 'PROCESSING' };
      display = {};
      await check.click();
      await browserExpect(
        frame.getByText('Estimated time remaining is unavailable.'),
      ).toBeVisible();
      await browserExpect(frame.getByRole('heading', { name: 'generation status' })).toBeVisible();
      await browserExpect(frame.getByRole('progressbar')).toHaveCount(0);
      malformed = true;
      await check.click();
      await browserExpect(frame.getByRole('alert')).toHaveText(
        'Unable to read this generation. Check status again.',
      );
      await browserExpect(check).toBeEnabled();
      malformed = false;
      current = {
        ...current,
        generationEstimate: {
          ...estimate,
          estimatedFinishAt: new Date(serverNow - 1000).toISOString(),
        },
      };
      await check.click();
      await browserExpect(frame.locator('#estimate')).toContainText('longer than estimated');
      // Both bridges must recover when a host never answers, then ignore its late reply.
      holdRead = true;
      await check.click();
      await browserExpect(frame.getByRole('button', { name: 'Checking status…' })).toBeDisabled();
      await browserExpect.poll(() => Boolean(releaseRead)).toBe(true);
      await page.clock.fastForward(15001);
      await browserExpect(frame.getByRole('alert')).toContainText('Sync did not respond');
      await browserExpect(check).toBeEnabled();
      current = {
        id: generationId,
        projectId,
        status: 'COMPLETED',
        model: 'sync-3',
        outputUrl: signedUrl,
      };
      display = { progress: { stage: 'completed', percent: 100 }, summary: still };
      await check.click();
      await browserExpect(frame.locator('output[aria-live="polite"]')).toHaveText('Completed');
      await browserExpect(frame.getByRole('heading', { name: 'Keynote in German' })).toBeVisible();
      await browserExpect(frame.getByRole('link', { name: 'View video' })).toHaveAttribute(
        'href',
        signedUrl,
      );
      await browserExpect(frame.locator('#estimate')).toBeHidden();
      await browserExpect(check).toBeEnabled();
      releaseRead();
      const video = frame.getByLabel('Generated video', { exact: true });
      if (bridge === 'no-media-policy') {
        await browserExpect(
          frame.getByText(
            'Preview unavailable. Use View video to open it, or check status for a fresh link.',
          ),
        ).toBeVisible();
      } else {
        await browserExpect(video).toHaveAttribute('src', signedUrl);
        await video.evaluate(async (element) => {
          element.muted = true;
          await element.play();
        });
        await browserExpect
          .poll(() =>
            video.evaluate((element) => element.getVideoPlaybackQuality().totalVideoFrames),
          )
          .toBeGreaterThan(0);
        await video.evaluate((element) => element.pause());
        await frame
          .getByRole('main')
          .screenshot({ path: `.cache/status-card/${shot}-completed.png` });
      }
      const resultOpened = context.waitForEvent('page');
      await frame.getByRole('link', { name: 'View video' }).click();
      const resultPage = await resultOpened;
      await resultPage.waitForURL(signedUrl);
      await resultPage.close();
      refuseLinks = true;
      await frame.getByRole('link', { name: 'View video' }).click();
      await browserExpect(frame.getByRole('alert')).toHaveText(
        'Unable to open this link. Try again.',
      );
      await browserExpect(frame.locator('output[aria-live="polite"]')).toHaveText('Completed');
      await browserExpect(frame.getByRole('link', { name: 'View video' })).toBeVisible();
      const reads = calls.length;
      await page.clock.fastForward(30000);
      await browserExpect(frame.locator('output[aria-live="polite"]')).toHaveText('Completed');
      expect(calls).toHaveLength(reads);
      expect(calls.filter((call) => call.path === '/v2/generate')).toHaveLength(1);
      expect(
        calls
          .filter((call) => call.path.startsWith('/v2/generate/'))
          .every((call) => call.path.endsWith(generationId)),
      ).toBe(true);
      refused = true;
      await check.click();
      await browserExpect(frame.getByRole('alert')).toContainText('Access unavailable');
      await browserExpect(frame.locator('video')).toHaveCount(0);
      await browserExpect(frame.getByRole('link', { name: 'View video' })).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await context.tracing.stop({ path: `.cache/status-card/${shot}-trace.zip` });
      await browser.close();
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
