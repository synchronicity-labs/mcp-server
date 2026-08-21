import { describe, expect, it, vi } from 'vitest';
import {
  encodeOAuthFormBody,
  extractBasicClientCredentials,
  getSessionRuntimeConfig,
  mergeBasicClientCredentials,
  runSessionSweepSafely,
} from './http-server.js';

describe('OAuth HTTP helpers', () => {
  it('extracts percent-encoded Basic client credentials', () => {
    const authorization = `Basic ${Buffer.from('client%3Aone:secret%3Atwo').toString('base64')}`;

    expect(extractBasicClientCredentials(authorization)).toEqual({
      clientId: 'client:one',
      clientSecret: 'secret:two',
    });
  });

  it('does not overwrite an explicit client_id body field', () => {
    expect(
      mergeBasicClientCredentials(
        { client_id: 'body-client' },
        `Basic ${Buffer.from('basic-client:secret').toString('base64')}`,
      ),
    ).toEqual({ client_id: 'body-client' });
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
  it('logs sweep failures and still emits telemetry', async () => {
    const sweep = vi.fn(async () => {
      throw new Error('sweep failed');
    });
    const logTelemetry = vi.fn();
    const log = vi.fn();

    await expect(runSessionSweepSafely({ sweep }, logTelemetry, log)).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('sweep failed'));
    expect(logTelemetry).toHaveBeenCalledOnce();
  });
});

describe('MCP session runtime config', () => {
  it('uses bounded defaults', () => {
    expect(getSessionRuntimeConfig({})).toEqual({
      idleTtlMs: 30 * 60_000,
      maxSessions: 1_000,
      sweepIntervalMs: 60_000,
      shutdownGraceMs: 10_000,
    });
  });

  it('accepts positive integer overrides and ignores invalid values', () => {
    expect(
      getSessionRuntimeConfig({
        MCP_SESSION_IDLE_TTL_MS: '900000',
        MCP_MAX_SESSIONS: '250',
        MCP_SESSION_SWEEP_INTERVAL_MS: '15000',
        MCP_SHUTDOWN_GRACE_MS: '5000',
      }),
    ).toEqual({
      idleTtlMs: 900_000,
      maxSessions: 250,
      sweepIntervalMs: 15_000,
      shutdownGraceMs: 5_000,
    });

    expect(
      getSessionRuntimeConfig({
        MCP_SESSION_IDLE_TTL_MS: '0',
        MCP_MAX_SESSIONS: '-1',
        MCP_SESSION_SWEEP_INTERVAL_MS: 'wat',
        MCP_SHUTDOWN_GRACE_MS: '-1',
      }),
    ).toEqual({
      idleTtlMs: 30 * 60_000,
      maxSessions: 1_000,
      sweepIntervalMs: 60_000,
      shutdownGraceMs: 10_000,
    });
  });
});
