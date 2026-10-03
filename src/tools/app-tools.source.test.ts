import { execFileSync } from 'node:child_process';
import { type LookupAddress, lookup } from 'node:dns';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../http-client.js';
import { routeUploadSourceToFixture } from '../test-fixtures/upload-source.js';
import { UploadRuntime } from '../upload-runtime.js';
import { createAppTools } from './app-tools.js';

vi.mock('node:dns', () => ({ lookup: vi.fn() }));

const serveSource: RequestListener = (request, response) => {
  reads.push(request.url ?? '');
  if (request.url === '/redirect') {
    response.writeHead(302, { Location: 'http://127.0.0.1/private' }).end();
  } else {
    response.writeHead(200, { 'Content-Type': 'video/mp4' }).end('offline uploaded bytes');
  }
};
const server = createServer(serveSource);
const identity = (() => {
  const directory = mkdtempSync(join(tmpdir(), 'sync-upload-source-tls-'));
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  const configPath = join(directory, 'openssl.cnf');
  try {
    writeFileSync(
      configPath,
      '[req]\ndistinguished_name = dn\n[dn]\n[extensions]\nsubjectAltName = DNS:uploads.test\n',
    );
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=uploads.test',
        '-config',
        configPath,
        '-extensions',
        'extensions',
      ],
      { stdio: 'ignore', timeout: 10_000 },
    );
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();
const certificate = identity.cert;
const secureServer = createSecureServer(identity, serveSource);
const reads: string[] = [];
const initialDispatcher = getGlobalDispatcher();
let transport: ReturnType<typeof routeUploadSourceToFixture>;
let lookups = 0;
let addresses: LookupAddress[] = [];

beforeEach(async () => {
  addresses = [{ address: '93.184.216.34', family: 4 }];
  lookups = 0;
  reads.length = 0;
  vi.mocked(lookup).mockImplementation(((
    _host: string,
    _options: unknown,
    callback: (error: Error | null, addresses: LookupAddress[]) => void,
  ) => {
    lookups += 1;
    callback(null, addresses);
  }) as typeof lookup);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  await new Promise<void>((resolve) => secureServer.listen(0, '127.0.0.1', resolve));
  const secureAddress = secureServer.address();
  if (!secureAddress || typeof secureAddress === 'string')
    throw new Error('missing TLS fixture port');
  transport = routeUploadSourceToFixture(address.port, {
    port: secureAddress.port,
    ca: certificate,
  });
});

afterEach(async () => {
  transport.restore();
  server.closeAllConnections();
  secureServer.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => secureServer.close(() => resolve()));
  setGlobalDispatcher(initialDispatcher);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup({ timeoutMs = 2_000 } = {}) {
  const runtime = new UploadRuntime({
    maxBytes: 100,
    maxConcurrent: 1,
    maxQueued: 0,
    timeoutMs,
    retryAfterMs: 100,
  });
  const request = vi.fn<HttpClient['request']>(async () => {
    throw new Error('Rejected source reached asset storage');
  });
  const tool = createAppTools({ request }, runtime).find((tool) => tool.name === 'upload-media');
  if (!tool) throw new Error('missing upload-media');
  const upload = (download_url: string) =>
    tool.handler({ mediaType: 'video', file: { download_url, file_id: 'untrusted' } });
  return { upload, request, runtime };
}

function stageStorage(request: ReturnType<typeof setup>['request']) {
  const nativeFetch = globalThis.fetch;
  const stored: Buffer[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (init?.method !== 'PUT') return nativeFetch(input, init);
      for await (const chunk of init.body as AsyncIterable<Buffer>) stored.push(chunk);
      return new Response(null);
    }),
  );
  request.mockImplementation(async (_method, path) =>
    path === '/v2/assets/upload'
      ? { uploadUrl: 'http://storage.test/file', url: 'https://cdn.sync.so/file' }
      : { id: 'durable-asset' },
  );
  return stored;
}

describe('upload source destination enforcement at the tool boundary', () => {
  it.each([
    'http://127.0.0.1/private',
    'http://127.1/private',
    'http://2130706433/private',
    'http://0x7f000001/private',
    'http://0.0.0.0/private',
    'http://10.0.0.1/private',
    'http://172.16.0.1/private',
    'http://192.168.0.1/private',
    'http://169.254.169.254/private',
    'http://100.64.0.1/private',
    'http://192.0.2.1/private',
    'http://198.18.0.1/private',
    'http://224.0.0.1/private',
    'http://240.0.0.1/private',
    'http://[::1]/private',
    'http://[::]/private',
    'http://[fc00::1]/private',
    'http://[fe80::1]/private',
    'http://[fec0::1]/private',
    'http://[ff02::1]/private',
    'http://[2001:db8::1]/private',
    'http://[::ffff:127.0.0.1]/private',
    'http://[::ffff:a00:1]/private',
    'http://[64:ff9b::a00:1]/private',
    'http://[2002:7f00:1::1]/private',
    'http://[4000::1]/private',
    'http://user:secret@uploads.test/source',
    'http://uploads.test:22/source',
    'https://uploads.test:80/source',
    'http://[fe80::1%25eth0]/private',
    'http://bad%00host/source',
  ])('rejects unsafe URL %s before reading or storing bytes', async (url) => {
    const { upload, request, runtime } = setup();
    await expect(upload(url)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
    expect(runtime.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      downloadedBytes: 0,
      uploadedBytes: 0,
      cleanupFailures: 0,
    });
  });

  it.each([
    { results: [{ address: '10.0.0.1', family: 4 }] },
    { results: [{ address: '::1', family: 6 }] },
    { results: [{ address: '::ffff:169.254.169.254', family: 6 }] },
    {
      results: [
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.1', family: 4 },
      ],
    },
    { results: [] },
  ])('rejects DNS result %j before source or storage requests', async ({ results }) => {
    addresses = results;
    const { upload, request, runtime } = setup();
    await expect(upload('http://uploads.test/source')).rejects.toThrow();
    expect(lookups).toBe(1);
    expect(reads).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toMatchObject({ active: 0, queued: 0, downloadedBytes: 0 });
  });

  it('does not follow a public source redirect into a private destination', async () => {
    const { upload, request, runtime } = setup();
    await expect(upload('http://uploads.test/redirect')).rejects.toThrow();
    expect(reads).toEqual(['/redirect']);
    expect(request).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toMatchObject({ active: 0, queued: 0, downloadedBytes: 0 });
  });

  it.each([
    'http:',
    'https:',
  ])('pins a %s source connection and rejects a later rebound lookup', async (protocol) => {
    const { upload, request, runtime } = setup();
    const blockedGlobal = new MockAgent();
    blockedGlobal.disableNetConnect();
    setGlobalDispatcher(blockedGlobal);
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:9');
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:9');
    const stored = stageStorage(request);
    vi.mocked(lookup).mockImplementation(((
      _host: string,
      _options: unknown,
      callback: (error: Error | null, addresses: LookupAddress[]) => void,
    ) => {
      lookups += 1;
      callback(
        null,
        lookups === 1
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }],
      );
    }) as typeof lookup);
    await expect(upload(`${protocol}//uploads.test/source`)).resolves.toMatchObject({
      assetId: 'durable-asset',
    });
    expect(Buffer.concat(stored).toString()).toBe('offline uploaded bytes');
    expect(lookups).toBe(1);
    request.mockClear();
    await expect(upload(`${protocol}//uploads.test/source`)).rejects.toThrow();
    expect(lookups).toBe(2);
    expect(transport.connectedAddresses).toEqual(['93.184.216.34']);
    expect(reads).toEqual(['/source']);
    expect(request).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      completed: 1,
      failed: 1,
      cleanupFailures: 0,
    });
    await blockedGlobal.close();
  });
  it.each([
    { url: 'http://93.184.216.34/source', address: '93.184.216.34', family: 4 },
    { url: 'http://[2606:4700:4700::1111]/source', address: '2606:4700:4700::1111', family: 6 },
    {
      url: 'http://uploads.test/source?signature=offline',
      address: '2606:4700:4700::1111',
      family: 6,
    },
  ])('stages a public source into durable storage: $url', async ({ url, address, family }) => {
    addresses = [{ address, family }];
    const { upload, request, runtime } = setup();
    const stored = stageStorage(request);
    await expect(upload(url)).resolves.toMatchObject({ assetId: 'durable-asset' });
    expect(Buffer.concat(stored).toString()).toBe('offline uploaded bytes');
    expect(transport.connectedAddresses).toEqual([address]);
    expect(runtime.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      completed: 1,
      cleanupFailures: 0,
    });
  });

  it('releases a timed-out source connection while DNS is still pending', async () => {
    vi.mocked(lookup).mockImplementation(() => {});
    const { upload, request, runtime } = setup({ timeoutMs: 30 });
    await expect(upload('http://uploads.test/source')).rejects.toThrow('timed out');
    expect(reads).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      failed: 1,
      downloadedBytes: 0,
    });
  }, 1_000);
  it.each([
    { results: [{ address: '10.0.0.1', family: 4 }] },
    { results: [{ address: 'fc00::1', family: 6 }] },
    {
      results: [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    },
  ])('rejects private or mixed DNS answers on the TLS connection: $results', async ({
    results,
  }) => {
    addresses = results;
    const { upload, request, runtime } = setup();
    await expect(upload('https://uploads.test/source')).rejects.toThrow();
    expect(lookups).toBe(1);
    expect(reads).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toMatchObject({ active: 0, queued: 0, downloadedBytes: 0 });
  });

  it.each([
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ])('stages a checked HTTPS source with trusted hostname verification: $address', async (address) => {
    addresses = [address];
    const { upload, request, runtime } = setup();
    const stored = stageStorage(request);
    await expect(upload('https://uploads.test/source?signature=offline')).resolves.toMatchObject({
      assetId: 'durable-asset',
    });
    expect(Buffer.concat(stored).toString()).toBe('offline uploaded bytes');
    expect(transport.connectedAddresses).toEqual([address.address]);
    expect(runtime.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      completed: 1,
      cleanupFailures: 0,
    });
  });
  it('retains TLS certificate hostname verification for public sources', async () => {
    const { upload, request, runtime } = setup();
    await expect(upload('https://wrong-host.test/source')).rejects.toThrow(
      /certificate|altname|hostname/,
    );
    expect(lookups).toBe(1);
    expect(reads).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toMatchObject({ active: 0, queued: 0, downloadedBytes: 0 });
  });
});
