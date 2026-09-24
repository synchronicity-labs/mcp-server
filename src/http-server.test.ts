import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  closeHttpServerWithGrace,
  createRequestId,
  encodeOAuthFormBody,
  extractBasicClientCredentials,
  getSessionRuntimeConfig,
  listenWithCleanup,
  runSessionSweepSafely,
  sanitizeDiagnosticUrl,
  waitForHttpServerStartup,
} from './http-server.js';

describe('HTTP server diagnostics', () => {
  it('removes URL credentials, query parameters, and fragments', () => {
    expect(
      sanitizeDiagnosticUrl(
        'https://api-user:api-password@api.sync.so/v2/generations?api_key=query-secret#fragment-secret',
      ),
    ).toBe('https://api.sync.so/v2/generations');
  });
});

describe('HTTP server startup', () => {
  it('cleans up runtime resources when listen throws synchronously', async () => {
    const listenError = new Error('listen failed synchronously');
    const cleanup = vi.fn();
    const waitForStartup = vi.fn(async () => undefined);

    await expect(
      listenWithCleanup(
        () => {
          throw listenError;
        },
        waitForStartup,
        cleanup,
      ),
    ).rejects.toBe(listenError);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(waitForStartup).not.toHaveBeenCalled();
  });

  it('force-closes active connections at the shutdown grace deadline', async () => {
    vi.useFakeTimers();
    let onClose: ((error?: Error) => void) | undefined;
    const httpServer = {
      close: vi.fn((callback: (error?: Error) => void) => {
        onClose = callback;
      }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };

    const closing = closeHttpServerWithGrace(httpServer, 100);

    expect(httpServer.close).toHaveBeenCalledOnce();
    expect(httpServer.closeIdleConnections).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(99);
    expect(httpServer.closeAllConnections).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(httpServer.closeAllConnections).toHaveBeenCalledOnce();
    onClose?.();
    await expect(closing).resolves.toEqual({ forced: true });
    vi.useRealTimers();
  });

  it('logs structured diagnostics and rejects fatal listen errors', async () => {
    const httpServer = new EventEmitter();
    const logEvent = vi.fn();
    const listenError = Object.assign(new Error('listen EADDRINUSE: address already in use'), {
      code: 'EADDRINUSE',
    });

    const startup = waitForHttpServerStartup(httpServer, logEvent);
    httpServer.emit('error', listenError);

    await expect(startup).rejects.toBe(listenError);
    expect(logEvent).toHaveBeenCalledWith('http_server_error', {
      error: expect.objectContaining({
        code: 'EADDRINUSE',
        message: expect.stringContaining('address already in use'),
      }),
    });

    expect(() => httpServer.emit('error', new Error('later server error'))).not.toThrow();
  });
});

describe('HTTP request IDs', () => {
  it('accepts request IDs up to 128 characters', () => {
    const requestId = 'r'.repeat(128);

    expect(createRequestId(requestId)).toBe(requestId);
  });

  it('replaces oversized request IDs with a UUID', () => {
    expect(createRequestId('r'.repeat(129))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('OAuth HTTP helpers', () => {
  it('extracts percent-encoded Basic client credentials', () => {
    const authorization = `Basic ${Buffer.from('client%3Aone:secret%3Atwo').toString('base64')}`;

    expect(extractBasicClientCredentials(authorization)).toEqual({
      clientId: 'client:one',
      clientSecret: 'secret:two',
    });
  });

  it('encodes only OAuth form fields for upstream proxying', () => {
    expect(
      encodeOAuthFormBody({
        grant_type: 'refresh_token',
        client_id: 'client-123',
        client_secret: 'secret-456',
        refresh_token: 'refresh-789',
        ignored: 'nope',
      }),
    ).toBe(
      'grant_type=refresh_token&client_id=client-123&client_secret=secret-456&refresh_token=refresh-789',
    );
  });
});

describe('MCP session sweeping', () => {
  it('does not emit a diagnostic after a successful sweep', async () => {
    const sweep = vi.fn(async () => undefined);
    const logEvent = vi.fn();

    await expect(runSessionSweepSafely({ sweep }, logEvent)).resolves.toBeUndefined();

    expect(sweep).toHaveBeenCalledOnce();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('emits a structured diagnostic when a sweep fails', async () => {
    const sweepError = new Error('sweep failed');
    const sweep = vi.fn(async () => {
      throw sweepError;
    });
    const logEvent = vi.fn();

    await expect(runSessionSweepSafely({ sweep }, logEvent)).resolves.toBeUndefined();

    expect(logEvent).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith('mcp_session_sweep_error', {
      error: expect.objectContaining({
        name: 'Error',
        message: 'sweep failed',
        stack: expect.stringContaining('Error: sweep failed'),
      }),
    });
  });
});

describe('MCP session runtime config', () => {
  it('uses bounded defaults', () => {
    expect(getSessionRuntimeConfig({})).toEqual({
      idleTtlMs: 30 * 60_000,
      maxSessions: 1_000,
      sweepIntervalMs: 60_000,
      shutdownGraceMs: 10_000,
      telemetryIntervalMs: 15_000,
    });
  });

  it('accepts positive integer overrides and ignores invalid values', () => {
    expect(
      getSessionRuntimeConfig({
        MCP_SESSION_IDLE_TTL_MS: '900000',
        MCP_MAX_SESSIONS: '250',
        MCP_SESSION_SWEEP_INTERVAL_MS: '15000',
        MCP_SHUTDOWN_GRACE_MS: '5000',
        MCP_RUNTIME_TELEMETRY_INTERVAL_MS: '7500',
      }),
    ).toEqual({
      idleTtlMs: 900_000,
      maxSessions: 250,
      sweepIntervalMs: 15_000,
      shutdownGraceMs: 5_000,
      telemetryIntervalMs: 7_500,
    });

    expect(
      getSessionRuntimeConfig({
        MCP_SESSION_IDLE_TTL_MS: '0',
        MCP_MAX_SESSIONS: '-1',
        MCP_SESSION_SWEEP_INTERVAL_MS: 'wat',
        MCP_SHUTDOWN_GRACE_MS: '-1',
        MCP_RUNTIME_TELEMETRY_INTERVAL_MS: '0',
      }),
    ).toEqual({
      idleTtlMs: 30 * 60_000,
      maxSessions: 1_000,
      sweepIntervalMs: 60_000,
      shutdownGraceMs: 10_000,
      telemetryIntervalMs: 15_000,
    });
  });
});
