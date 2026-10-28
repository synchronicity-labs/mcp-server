import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, expect } from '@playwright/test';

// Run against a built, immutable UI bundle. Only the identity provider and Sync API are fixtures.
if (!process.argv[2])
  throw new Error('Usage: node scripts/verify-account-recovery.mjs /path/to/chatgpt/dist/app.html');
const appPath = resolve(process.argv[2]);
await readFile(appPath);
const output = resolve('temp/account-recovery');
await mkdir(output, { recursive: true });
const account = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'recovery@example.test',
  name: 'Recovery tester',
};
const organization = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Recovery workspace',
  role: 'member',
};
const writes = [];
let challenges = 0;
let limitsStatus = 200;
const api = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'GET') writes.push(req.url);
  if (req.url === '/api-json')
    return void res.end(
      JSON.stringify({
        openapi: '3.0.0',
        paths: {
          '/v2/projects': {
            get: {
              operationId: 'ProjectsController_getAll',
              tags: ['Projects'],
              responses: {
                200: {
                  description: 'Projects',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { items: { type: 'array', items: { type: 'object' } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
  if (req.url === '/v2/oauth/token') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const grant = new URLSearchParams(body);
    assert.equal(grant.get('grant_type'), 'authorization_code');
    assert.equal(grant.get('code'), 'fixture-consent-code');
    return void res.end(
      JSON.stringify({ access_token: 'recovered-fixture', token_type: 'Bearer', expires_in: 3600 }),
    );
  }
  const token = req.headers.authorization;
  if (req.url === '/v2/oauth/userinfo') {
    if (!['Bearer original-fixture', 'Bearer recovered-fixture'].includes(token))
      return void res.writeHead(401).end('{}');
    return void res.end(
      JSON.stringify({
        sub: account.id,
        organization_id: organization.id,
        client_id: 'fixture-client',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
  }
  if (req.url === '/v2/oauth/account') {
    if (token !== 'Bearer recovered-fixture')
      return void res.writeHead(401).end(JSON.stringify({ message: 'Invalid or expired token' }));
    return void res.end(JSON.stringify({ account, organization }));
  }
  if (req.url === '/v2/plans/limits')
    return void res
      .writeHead(limitsStatus)
      .end(
        JSON.stringify(
          limitsStatus === 200 ? { seats: 3, voiceClone: 5 } : { message: 'Limits unavailable' },
        ),
      );
  if (req.url?.startsWith('/v2/projects')) return void res.end(JSON.stringify({ items: [] }));
  if (req.url === '/v2/billing')
    return void res.writeHead(503).end(JSON.stringify({ message: 'Usage unavailable' }));
  res.writeHead(404).end('{}');
});
await new Promise((done) => api.listen(0, '127.0.0.1', done));
const baseUrl = `http://127.0.0.1:${api.address().port}`;
const reserve = createServer();
await new Promise((done) => reserve.listen(0, '127.0.0.1', done));
const port = reserve.address().port;
await new Promise((done) => reserve.close(done));
const origin = `http://127.0.0.1:${port}`;
const config = {
  baseUrl,
  transport: 'http',
  port,
  chatgptApp: {
    directory: dirname(appPath),
    domain: 'https://recovery.fixture.invalid',
    resourceDomains: [],
  },
};
const child = spawn(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import { createMcpServerFactory } from './dist/server.js'; import { startHttpServer } from './dist/http-server.js'; const config = JSON.parse(process.argv[1]); await startHttpServer(await createMcpServerFactory(config), config);`,
    JSON.stringify(config),
  ],
  {
    cwd: resolve('.'),
    env: { PATH: process.env.PATH, MCP_ISSUER_URL: origin },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let log = '';
child.stderr.on('data', (chunk) => {
  log += chunk;
});
let client;
let browser;
let host;
async function connect(token) {
  await client?.close();
  client = new Client({ name: 'openai-mcp', version: 'recovery-verification' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', origin), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
}
try {
  await expect
    .poll(
      () => {
        if (child.exitCode !== null) throw new Error(log);
        return log.includes('server_listening');
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const unauthenticated = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get('www-authenticate'), /oauth-protected-resource/);
  await connect('original-fixture');
  const resources = await client.listResources();
  const resource = resources.resources.find((item) => item.name === 'sync-app');
  assert(resource);
  const html = (await client.readResource({ uri: resource.uri })).contents[0].text;
  host = createServer(async (req, res) => {
    try {
      if (req.url === '/app') return void res.setHeader('content-type', 'text/html').end(html);
      if (req.url === '/tool') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const result = await client.callTool(JSON.parse(body));
        if (result._meta?.['mcp/www_authenticate']) challenges++;
        return void res.setHeader('content-type', 'application/json').end(JSON.stringify(result));
      }
      if (req.url === '/authorize' && req.method === 'POST') {
        const response = await fetch(`${origin}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'fixture-consent-code',
            client_id: 'fixture-client',
            client_secret: 'fixture-secret',
            redirect_uri: 'https://chatgpt.com/fixture',
            code_verifier: 'fixture-verifier',
          }),
        });
        assert.equal(response.status, 200);
        await connect((await response.json()).access_token);
        return void res.end('authorized');
      }
      res
        .setHeader('content-type', 'text/html')
        .end(
          '<button id="authorize">Authorize Sync (fixture host)</button><iframe title="Sync" src="/app" style="width:100%;height:850px;border:0"></iframe><script>document.querySelector("button").onclick=async()=>{await fetch("/authorize",{method:"POST"});document.querySelector("button").textContent="Authorized";};</script>',
        );
    } catch (error) {
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((done) => host.listen(0, '127.0.0.1', done));
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1000, height: 1000 } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await context.addInitScript(() => {
    if (window === window.parent) return;
    window.openai = {
      callTool: async (name, args) => {
        const response = await fetch('/tool', {
          method: 'POST',
          body: JSON.stringify({ name, arguments: args }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        return result;
      },
      widgetState: null,
      setWidgetState: () => {},
    };
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${host.address().port}`);
  const app = page.frameLocator('iframe');
  await expect(app.getByRole('button', { name: 'Reconnect to Sync', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await app.getByRole('button', { name: 'Reconnect to Sync', exact: true }).click();
  await expect(app.getByRole('button', { name: 'Check connection', exact: true })).toBeEnabled();
  assert(challenges >= 2, 'MCP must issue OAuth challenges before and after an unsuccessful retry');
  await page.screenshot({ path: resolve(output, 'reconnect.png') });
  await page.getByRole('button', { name: 'Authorize Sync (fixture host)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Authorized', exact: true })).toBeVisible();
  limitsStatus = 503;
  await app.getByRole('button', { name: 'Check connection', exact: true }).click();
  await app.getByRole('button', { name: 'Sync account', exact: true }).click();
  const accountMenu = app.getByRole('dialog', { name: 'Sync account' });
  await expect(accountMenu.getByText(account.email, { exact: true })).toBeVisible();
  await expect(accountMenu.getByText(organization.name, { exact: true })).toBeVisible();
  await expect(
    accountMenu.getByText('Usage is temporarily unavailable.', { exact: true }),
  ).toBeVisible();
  assert.deepEqual(
    writes,
    ['/v2/oauth/token'],
    'Recovery must never create a video or another write',
  );
  await page.screenshot({ path: resolve(output, 'connected.png'), animations: 'disabled' });
  await context.tracing.stop({ path: resolve(output, 'trace.zip') });
  console.log(
    `PASS: browser → MCP HTTP → account refusal → OAuth challenge → token exchange → verified identity; no paid writes. Evidence: ${output}`,
  );
} finally {
  await browser?.close();
  await client?.close();
  host?.closeAllConnections();
  if (host) await new Promise((done) => host.close(done));
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  api.closeAllConnections();
  await new Promise((done) => api.close(done));
}
