import { mkdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect as browserExpect, chromium } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import { createMcpServerFactory } from './server.js';

afterEach(() => vi.unstubAllGlobals());

// Exercise a served resource, real MCP tools and a browser host together. The API
// fixture never performs provider work; every status read must retain the one job.
it.each([
  'standard',
  'legacy',
  'uncertain',
  'legacy-uncertain',
])('checks one accepted job and its server-clock ETA through the %s bridge', async (bridge) => {
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
  let current = { id: generationId, projectId, status: 'PROCESSING', generationEstimate: estimate };
  let refused = false;
  let malformed = false;
  let refuseLinks = false;
  let holdRead = false;
  let releaseRead;
  const calls = [];
  vi.stubGlobal('fetch', async (input, init) => {
    const path = new URL(input).pathname;
    if (path === '/api-json')
      return Response.json({
        openapi: '3.0.0',
        paths: {
          '/v2/generate/{id}': {
            get: {
              operationId: 'GenerateController_getGeneration',
              tags: ['Generate'],
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
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
        : Response.json(current);
    return Response.json({}, { status: 404 });
  });
  const factory = await createMcpServerFactory({
    baseUrl: 'https://fixture.invalid',
    transport: 'http',
    port: 0,
  });
  const server = factory.createServer();
  const client = new Client({ name: 'openai-mcp', version: '1.0.0' });
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
  await context.tracing.start({ screenshots: true, snapshots: true });
  await mkdir('.cache/status-card', { recursive: true });
  try {
    const descriptor = (await client.listTools()).tools.find(
      (tool) => tool.name === 'create-lipsync',
    );
    const accepted = await client.callTool({
      name: descriptor.name,
      arguments: {
        projectId,
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
    await page.evaluate(
      ({ html, accepted, bridge, fontSources }) => {
        html = html.replace(
          '<head>',
          `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src ${fontSources.join(' ')}">`,
        );
        const iframe = document.querySelector('iframe');
        window.addEventListener('message', async (event) => {
          if (event.source !== iframe.contentWindow) return;
          const message = event.data;
          if (message.method === 'ui/notifications/size-changed') {
            iframe.style.height = `${message.params.height}px`;
            return;
          }
          if (message.id === undefined) return;
          if (message.method === 'ui/initialize') {
            // Deliver immediately, including before initialization has finished.
            event.source.postMessage(
              { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: accepted },
              '*',
            );
            event.source.postMessage(
              {
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  protocolVersion: message.params.protocolVersion,
                  hostInfo: { name: 'fixture', version: '1' },
                  hostCapabilities: { serverTools: {} },
                  hostContext: { theme: 'dark' },
                },
              },
              '*',
            );
          } else if (message.method === 'ui/open-link') {
            if (!(await window.canOpenSyncLink())) {
              event.source.postMessage(
                {
                  jsonrpc: '2.0',
                  id: message.id,
                  error: { code: -32000, message: 'Fixture host refused navigation' },
                },
                '*',
              );
              return;
            }
            window.open(message.params.url, '_blank', 'noopener,noreferrer');
            event.source.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
          } else if (message.method === 'tools/call') {
            const result = await window.callSync(message.params);
            event.source.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*');
          }
        });
        if (bridge.startsWith('legacy'))
          html = html.replace(
            '<script>',
            '<script>window.openai = { theme: "light", toolOutput: ' +
              JSON.stringify(accepted.structuredContent) +
              ', callTool: (name, args) => window.parent.callSync({name, arguments: args}), openExternal: async options => { if (!await window.parent.canOpenSyncLink()) throw new Error("Fixture host refused navigation"); if (options.redirectUrl !== false) throw new Error("Signed links must not be rewritten"); window.parent.open(options.href, "_blank", "noopener,noreferrer"); }, notifyIntrinsicHeight: height => { window.frameElement.style.height = height + "px"; } };</script><script>',
          );
        iframe.srcdoc = html;
      },
      {
        html: resource.contents[0].text,
        accepted,
        bridge,
        fontSources: resource.contents[0]._meta.ui.csp.resourceDomains,
      },
    );
    const frame = page.frameLocator('iframe');
    await browserExpect(frame.getByRole('status')).toHaveText('Processing');
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
    await frame.getByRole('main').screenshot({ path: `.cache/status-card/${bridge}.png` });
    const cardBounds = await frame.getByRole('main').boundingBox();
    expect(cardBounds.width).toBeLessThanOrEqual(bridge === 'standard' ? 360 : 720);
    const beforePoll = calls.length;
    current.generationEstimate = {
      ...estimate,
      serverTime: new Date(serverNow + 11000).toISOString(),
    };
    await page.clock.fastForward(5000);
    await browserExpect.poll(() => calls.length).toBeGreaterThan(beforePoll);
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
    await check.click();
    await browserExpect(frame.getByText('Estimated time remaining is unavailable.')).toBeVisible();
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
    current = { id: generationId, projectId, status: 'COMPLETED', outputUrl: signedUrl };
    await check.click();
    await browserExpect(frame.getByRole('status')).toHaveText('Completed');
    await browserExpect(frame.getByRole('link', { name: 'View video' })).toHaveAttribute(
      'href',
      signedUrl,
    );
    await browserExpect(frame.locator('#estimate')).toBeHidden();
    await browserExpect(check).toBeEnabled();
    releaseRead();
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
    await browserExpect(frame.getByRole('status')).toHaveText('Completed');
    await browserExpect(frame.getByRole('link', { name: 'View video' })).toBeVisible();
    const reads = calls.length;
    await page.clock.fastForward(30000);
    await browserExpect(frame.getByRole('status')).toHaveText('Completed');
    expect(calls).toHaveLength(reads);
    expect(calls.filter((call) => call.path === '/v2/generate')).toHaveLength(1);
    expect(
      calls
        .filter((call) => call.path.startsWith('/v2/generate/'))
        .every((call) => call.path.endsWith(generationId)),
    ).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await context.tracing.stop({ path: `.cache/status-card/${bridge}-trace.zip` });
    await browser.close();
    await client.close();
    await server.close();
  }
}, 30000);
