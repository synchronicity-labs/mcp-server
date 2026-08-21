import { describe, expect, it, vi } from 'vitest';
import { SessionRegistry } from './session-registry.js';

type TestTransport = { close: () => Promise<void> };

function transport(): TestTransport {
  return { close: vi.fn(async () => undefined) };
}

describe('SessionRegistry', () => {
  it('reserves capacity before initialization and rejects sessions above the cap', () => {
    const registry = new SessionRegistry<TestTransport>({
      idleTtlMs: 30_000,
      maxSessions: 1,
    });

    const first = registry.reserve();

    expect(first).toBeDefined();
    expect(registry.reserve()).toBeUndefined();
    expect(registry.stats()).toMatchObject({ pending: 1, inFlight: 0, rejected: 1 });

    const value = transport();
    const initializationLease = first?.commit('session-1', value);
    const requestLease = registry.acquire('session-1');
    expect(requestLease).toBeDefined();
    expect(registry.stats()).toMatchObject({ pending: 0, inFlight: 2 });

    initializationLease?.release();
    expect(registry.stats().inFlight).toBe(1);
    requestLease?.release();
    expect(registry.stats().inFlight).toBe(0);
  });

  it('rejects late commits after shutdown begins and releases pending capacity', () => {
    const registry = new SessionRegistry<TestTransport>({ idleTtlMs: 30_000, maxSessions: 1 });
    const reservation = registry.reserve();

    registry.stopAccepting();

    expect(() => reservation?.commit('late-session', transport())).toThrow(
      'Session registry is shutting down',
    );
    expect(registry.stats()).toMatchObject({ active: 0, pending: 0 });
    expect(registry.reserve()).toBeUndefined();
  });

  it('expires idle sessions and closes their transports', async () => {
    let now = 1_000;
    const registry = new SessionRegistry<TestTransport>({
      idleTtlMs: 30_000,
      maxSessions: 10,
      now: () => now,
    });
    const value = transport();
    const reservation = registry.reserve();
    reservation?.commit('session-1', value).release();

    now += 30_001;

    expect(await registry.sweep()).toBe(1);
    expect(registry.size).toBe(0);
    expect(value.close).toHaveBeenCalledOnce();
    expect(registry.stats().expired).toBe(1);
  });

  it('does not expire an active request and refreshes activity when released', async () => {
    let now = 1_000;
    const registry = new SessionRegistry<TestTransport>({
      idleTtlMs: 30_000,
      maxSessions: 10,
      now: () => now,
    });
    const value = transport();
    registry.reserve()?.commit('session-1', value).release();

    const lease = registry.acquire('session-1');
    now += 60_000;

    expect(await registry.sweep()).toBe(0);
    expect(value.close).not.toHaveBeenCalled();

    lease?.release();
    expect(await registry.sweep()).toBe(0);

    now += 30_001;
    expect(await registry.sweep()).toBe(1);
    expect(value.close).toHaveBeenCalledOnce();
  });

  it('isolates removal observer errors and still closes expired transports', async () => {
    let now = 1_000;
    const onCloseError = vi.fn();
    const registry = new SessionRegistry<TestTransport>({
      idleTtlMs: 30_000,
      maxSessions: 10,
      now: () => now,
      onRemove: () => {
        throw new Error('observer failed');
      },
      onCloseError,
    });
    const value = transport();
    registry.reserve()?.commit('session-1', value).release();
    now += 30_001;

    await expect(registry.sweep()).resolves.toBe(1);
    expect(value.close).toHaveBeenCalledOnce();
    expect(onCloseError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'observer failed' }),
    );
  });

  it('removes closed sessions without closing the transport twice', async () => {
    const onRemove = vi.fn();
    const registry = new SessionRegistry<TestTransport>({
      idleTtlMs: 30_000,
      maxSessions: 10,
      onRemove,
    });
    const value = transport();
    registry.reserve()?.commit('session-1', value).release();

    await registry.remove('session-1', 'closed', false);

    expect(registry.size).toBe(0);
    expect(value.close).not.toHaveBeenCalled();
    expect(registry.stats().closed).toBe(1);
    expect(onRemove).toHaveBeenCalledWith('session-1', 'closed');
  });
});
