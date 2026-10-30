#!/usr/bin/env node
// Captures what each client sees from the built server, for before/after comparisons:
//   node scripts/capture-wire.mjs capture --out before.json [--spec path/to/api-json.json]
//   node scripts/capture-wire.mjs diff before.json after.json
// It speaks raw HTTP and stdio JSON-RPC, so it does not depend on the MCP SDK under
// test, and runs the server against a local stub API with a saved public spec.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENTS = [
  'openai-mcp',
  'openai-mcp (Codex)',
  'claude-ai',
  'Anthropic/ClaudeAI',
  'claude-code',
  'cursor-vscode',
];
const VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'];
const ACCEPT = 'application/json, text/event-stream';
const TOKEN = 'capture-token';
const REQUEST_TIMEOUT_MS = 30_000;

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

/** Paths whose values differ between two captures. */
export function diffCaptures(before, after, path = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const bothObjects = before && after && typeof before === 'object' && typeof after === 'object';
  if (!bothObjects || Array.isArray(before) !== Array.isArray(after)) {
    return [{ path: path || '/', before, after }];
  }
  if (Array.isArray(before) && before.length !== after.length) {
    return [{ path: `${path}.length`, before: before.length, after: after.length }];
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key) => diffCaptures(before[key], after[key], `${path}/${key}`));
}

function freePort() {
  return new Promise((done, fail) => {
    const server = http.createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function loadSpec(specPath) {
  if (specPath) return readFileSync(specPath, 'utf8');
  const cached = join(ROOT, '.cache', 'api-json.json');
  if (existsSync(cached)) return readFileSync(cached, 'utf8');
  const res = await fetch('https://api.sync.so/api-json', {
    headers: { 'user-agent': 'sync-mcp-capture-wire' },
  });
  if (!res.ok) throw new Error(`Fetching the public spec returned ${res.status}`);
  const text = await res.text();
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, text);
  return text;
}

async function parseBody(res, id) {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const message = JSON.parse(line.slice(5));
      if (id === undefined || message.id === id) return message;
    }
    return { sse: text };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function httpClient(base) {
  let nextId = 1;
  const post = async (body, headers = {}) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        authorization: `Bearer ${TOKEN}`,
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res;
  };
  const rpc = async (session, method, params) => {
    const id = nextId++;
    const res = await post(
      { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) },
      session ? { 'mcp-session-id': session.id, 'mcp-protocol-version': session.version } : {},
    );
    return { res, body: await parseBody(res, id) };
  };
  return { post, rpc };
}

// A response as the client saw it, so a changed status or error shows in the diff. The
// JSON-RPC id only reflects request order, so it is left out.
function seen(res, body) {
  return { status: res.status, ...body, id: undefined };
}

async function listAll(rpc, session, method, key) {
  const items = [];
  let cursor;
  do {
    const { res, body } = await rpc(session, method, cursor ? { cursor } : {});
    if (!res.ok || !body.result) return seen(res, body);
    items.push(...(body.result[key] ?? []));
    cursor = body.result.nextCursor;
  } while (cursor);
  return items;
}

async function captureClient(base, name) {
  const { post, rpc } = httpClient(base);
  const init = await rpc(undefined, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name, version: '1.0.0' },
  });
  const session = {
    id: init.res.headers.get('mcp-session-id'),
    version: init.body.result?.protocolVersion,
  };
  await (
    await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { 'mcp-session-id': session.id, 'mcp-protocol-version': session.version },
    )
  ).text();
  const tools = await listAll(rpc, session, 'tools/list', 'tools');
  const unknownTool = await rpc(session, 'tools/call', { name: 'does-not-exist', arguments: {} });
  const result = {
    initialize: init.body.result ?? init.body,
    tools: Array.isArray(tools) ? tools.sort((a, b) => a.name.localeCompare(b.name)) : tools,
    resources: await listAll(rpc, session, 'resources/list', 'resources'),
    resourceTemplates: await listAll(rpc, session, 'resources/templates/list', 'resourceTemplates'),
    prompts: await listAll(rpc, session, 'prompts/list', 'prompts'),
    unknownTool: seen(unknownTool.res, unknownTool.body),
  };
  await (
    await fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}`, 'mcp-session-id': session.id },
    })
  ).text();
  return result;
}

async function captureHttp(env, port) {
  const child = spawn(
    process.execPath,
    ['dist/cli.js', '--transport', 'http', '--port', String(port)],
    { cwd: ROOT, env, stdio: 'ignore' },
  );
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {
        // Not listening yet.
      }
      await new Promise((done) => setTimeout(done, 200));
    }
    const out = { publicDocuments: {}, protocolVersions: {}, clients: {} };
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
    ]) {
      const res = await fetch(`${base}${path}`);
      out.publicDocuments[path] = { status: res.status, body: await parseBody(res) };
    }
    const unauthenticated = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    await unauthenticated.text();
    out.unauthenticated = {
      status: unauthenticated.status,
      wwwAuthenticate: unauthenticated.headers.get('www-authenticate'),
    };
    const { rpc } = httpClient(base);
    for (const version of VERSIONS) {
      const { body } = await rpc(undefined, 'initialize', {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: 'version-probe', version: '1' },
      });
      out.protocolVersions[version] = body.result?.protocolVersion ?? body.error ?? null;
    }
    for (const name of CLIENTS) out.clients[name] = await captureClient(base, name);
    return out;
  } finally {
    child.kill('SIGTERM');
  }
}

async function captureStdio(env, name) {
  const child = spawn(process.execPath, ['dist/cli.js'], {
    cwd: ROOT,
    env: { ...env, SYNC_API_KEY: 'capture-key' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buffer = '';
  let nextId = 1;
  const waiters = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      waiters.get(message.id)?.done(message);
    }
  });
  child.on('exit', (code, signal) => {
    for (const waiter of waiters.values()) {
      waiter.fail(new Error(`The stdio server exited (${signal ?? code}) before replying.`));
    }
  });
  // A write to a dead child fails with EPIPE; the exit handler reports it instead.
  child.stdin.on('error', () => {});
  const send = (method, params) => {
    const id = nextId++;
    const reply = new Promise((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`stdio ${method} got no reply within ${REQUEST_TIMEOUT_MS} ms.`)),
        REQUEST_TIMEOUT_MS,
      );
      const settle = (finish) => (value) => {
        clearTimeout(timer);
        waiters.delete(id);
        finish(value);
      };
      waiters.set(id, { done: settle(done), fail: settle(fail) });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return reply;
  };
  try {
    const init = await send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name, version: '1.0.0' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const list = await send('tools/list', {});
    return {
      initialize: init.result ?? init,
      // Keep an error response whole rather than reading it as an empty list.
      tools: list.result
        ? (list.result.tools ?? []).sort((a, b) => a.name.localeCompare(b.name))
        : { ...list, id: undefined },
    };
  } finally {
    child.kill('SIGTERM');
  }
}

async function capture({ out, spec }) {
  if (!existsSync(join(ROOT, 'dist', 'cli.js'))) throw new Error('Run `pnpm run build` first.');
  const releases = join(ROOT, 'chatgpt-dist', 'releases.json');
  if (!existsSync(releases)) {
    throw new Error('Run `pnpm run package:chatgpt` first so ChatGPT resources are captured.');
  }
  const specText = await loadSpec(spec);
  const stub = http.createServer((req, res) => {
    if (req.url.startsWith('/api-json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(specText);
    } else if (req.url.startsWith('/v2/oauth/userinfo')) {
      const valid = req.headers.authorization === `Bearer ${TOKEN}`;
      res.writeHead(valid ? 200 : 401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          valid
            ? {
                sub: 'user-1',
                client_id: 'client-1',
                organization_id: '00000000-0000-4000-8000-000000000001',
              }
            : { message: 'invalid' },
        ),
      );
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  await new Promise((done) => stub.listen(0, '127.0.0.1', done));
  const env = {
    ...process.env,
    SYNC_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
    SYNC_CHATGPT_APP_RELEASES: releases,
    SYNC_CHATGPT_APP_DOMAIN: 'https://mcp.sync.so',
    SYNC_APP_UPLOAD_STORAGE_ORIGIN: 'https://uploads.example.test',
    MCP_ISSUER_URL: 'https://mcp.sync.so',
    OAUTH_REGISTRATION_SECRET: 'capture-secret',
  };
  try {
    const result = {
      http: await captureHttp(env, await freePort()),
      stdio: {
        'claude-code': await captureStdio(env, 'claude-code'),
        'openai-mcp': await captureStdio(env, 'openai-mcp'),
      },
    };
    writeFileSync(out, `${JSON.stringify(sortKeys(result), null, 2)}\n`);
    console.log(`Wrote ${out}`);
  } finally {
    stub.close();
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'capture') {
      const out = option(args, '--out');
      if (!out) throw new Error('capture needs --out <file>');
      await capture({ out, spec: option(args, '--spec') });
      process.exit(0);
    } else if (command === 'diff' && args.length === 2) {
      const [before, after] = args.map((file) => JSON.parse(readFileSync(file, 'utf8')));
      const differences = diffCaptures(before, after);
      for (const { path, before: was, after: now } of differences) {
        console.log(`${path}\n  before: ${JSON.stringify(was)?.slice(0, 300)}`);
        console.log(`  after:  ${JSON.stringify(now)?.slice(0, 300)}`);
      }
      console.log(`${differences.length} difference(s)`);
      process.exit(differences.length > 0 ? 1 : 0);
    } else {
      console.error('Usage: capture-wire.mjs capture --out <file> [--spec <file>] | diff <a> <b>');
      process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
