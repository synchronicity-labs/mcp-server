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
    serverTime: new Date(serverNow).toISOString(),
    estimatedFinishAt: new Date(serverNow + 125000).toISOString(),
    delayedAt: new Date(serverNow + 600000).toISOString(),
  };
  const signedUrl = 'https://fixture.invalid/result.mp4?Signature=a%2Fb%2Bc&Expires=123';
  let current = { id: generationId, projectId, status: 'PROCESSING', generationEstimate: estimate };
  let refused = false;
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
    await page.exposeFunction('callSync', (request) => client.callTool(request));
    await page.setContent(
      '<iframe title="Sync status" sandbox="allow-scripts allow-same-origin" style="border:0;width:100%;height:350px"></iframe>',
    );
    await page.evaluate(
      ({ html, accepted, bridge }) => {
        const iframe = document.querySelector('iframe');
        window.addEventListener('message', async (event) => {
          if (event.source !== iframe.contentWindow) return;
          const message = event.data;
          if (message.method === 'ui/notifications/size-changed') {
            iframe.style.height = `${message.params.height}px`;
            return;
          }
          if (!message.id) return;
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
              ', callTool: (name, args) => window.parent.callSync({name, arguments: args}), notifyIntrinsicHeight: height => { window.frameElement.style.height = height + "px"; } };</script><script>',
          );
        iframe.srcdoc = html;
      },
      { html: resource.contents[0].text, accepted, bridge },
    );
    const frame = page.frameLocator('iframe');
    await browserExpect(frame.getByRole('status')).toHaveText('Processing');
    await browserExpect(frame.getByText('Estimated time remaining: about 3 minutes')).toBeVisible();
    const check = frame.getByRole('button', { name: 'Check status', exact: true });
    await browserExpect(check).toBeEnabled();
    await browserExpect(frame.getByRole('link', { name: 'Open in Sync' })).toHaveAttribute(
      'href',
      `https://sync.so/projects/${projectId}/studio?notification=generation&generationId=${generationId}`,
    );
    await page.clock.fastForward(6000);
    await browserExpect(frame.getByText('Estimated time remaining: about 2 minutes')).toBeVisible();
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
    current = {
      ...current,
      generationEstimate: {
        ...estimate,
        estimatedFinishAt: new Date(serverNow - 1000).toISOString(),
      },
    };
    await check.click();
    await browserExpect(frame.locator('#estimate')).toContainText('longer than estimated');
    current = { id: generationId, projectId, status: 'COMPLETED', outputUrl: signedUrl };
    await check.click();
    await browserExpect(frame.getByRole('status')).toHaveText('Completed');
    await browserExpect(frame.getByRole('link', { name: 'View video' })).toHaveAttribute(
      'href',
      signedUrl,
    );
    await browserExpect(frame.locator('#estimate')).toBeHidden();
    await browserExpect(check).toBeEnabled();
    const reads = calls.length;
    await page.clock.fastForward(30000);
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
