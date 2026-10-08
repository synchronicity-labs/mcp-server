import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performDeviceAuth } from './device-auth.js';
import { saveToken } from './token-store.js';

vi.mock('./token-store.js', () => ({ saveToken: vi.fn() }));
const baseUrl = 'https://api.example.com';
const start = {
  deviceCode: 'device-secret',
  userCode: 'ABC-123',
  verificationUri: 'https://example.com/device-auth/verify?code=ABC-123',
  expiresIn: 10,
  interval: 2,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('device authorization API contract', () => {
  it('honors polling interval and saves the returned token lifetime for this API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(start))
      .mockResolvedValueOnce(Response.json({ status: 'pending' }))
      .mockResolvedValueOnce(
        Response.json({ status: 'ready', accessToken: 'token', expiresIn: 60 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.fn();
    const result = performDeviceAuth(baseUrl, log);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2001);
    await expect(result).resolves.toMatchObject({ headers: { Authorization: 'Bearer token' } });
    expect(saveToken).toHaveBeenCalledWith('token', '2026-10-08T12:01:04.000Z', baseUrl);
    expect(log.mock.calls.flat().join('')).not.toContain('device-secret');
  });

  it.each([200, 404])('terminates expired codes returned with HTTP %s', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(start))
        .mockResolvedValueOnce(Response.json({ status: 'expired' }, { status })),
    );
    const result = expect(performDeviceAuth(baseUrl, vi.fn())).rejects.toThrow(/expired/i);
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(saveToken).not.toHaveBeenCalled();
  });

  it('stops at the advertised deadline even when the server keeps returning pending', async () => {
    const fetchMock = vi
      .fn(async () => Response.json({ status: 'pending' }))
      .mockImplementationOnce(async () => Response.json(start));
    vi.stubGlobal('fetch', fetchMock);
    const result = expect(performDeviceAuth(baseUrl, vi.fn())).rejects.toThrow(/expired/i);
    await vi.advanceTimersByTimeAsync(11000);
    await result;
    expect(saveToken).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'ready', accessToken: '', expiresIn: 60 },
    { status: 'ready', accessToken: 'token', expiresIn: 0 },
    { status: 'unexpected' },
  ])('rejects malformed poll responses without caching credentials: %j', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(start))
        .mockResolvedValueOnce(Response.json(body)),
    );
    const result = expect(performDeviceAuth(baseUrl, vi.fn())).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(saveToken).not.toHaveBeenCalled();
  });
});
