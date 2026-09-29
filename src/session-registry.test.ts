import { describe, expect, it, vi } from 'vitest';
import { SessionRegistry, sessionOwner } from './session-registry.js';

const owner = { sub: 'subject', clientId: 'client', organizationId: 'org' };

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
    const initializationLease = first?.commit('session-1', value, owner);
    const requestLease = registry.acquire('session-1', owner);
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

    expect(() => reservation?.commit('late-session', transport(), owner)).toThrow(
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
    reservation?.commit('session-1', value, owner).release();

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
    registry.reserve()?.commit('session-1', value, owner).release();

    const lease = registry.acquire('session-1', owner);
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
    registry.reserve()?.commit('session-1', value, owner).release();
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
    registry.reserve()?.commit('session-1', value, owner).release();

    await registry.remove('session-1', 'closed', false);

    expect(registry.size).toBe(0);
    expect(value.close).not.toHaveBeenCalled();
    expect(registry.stats().closed).toBe(1);
    expect(onRemove).toHaveBeenCalledWith('session-1', 'closed');
  });
});

it.each([
  { ...owner, sub: 'other' },
  { ...owner, clientId: 'other' },
  { ...owner, organizationId: 'other' },
  { ...owner, organizationId: null },
])('rejects foreign ownership without refreshing idle time: %j', async (foreign) => {
  let now = 0;
  const registry = new SessionRegistry<TestTransport>({
    idleTtlMs: 10,
    maxSessions: 1,
    now: () => now,
  });
  const value = transport();
  const snapshot = { ...owner };
  registry.reserve()!.commit('id', value, snapshot).release();
  snapshot.sub = 'mutated';
  now = 9;
  expect(registry.acquire('id', foreign)).toBeUndefined();
  expect(registry.stats().inFlight).toBe(0);
  now = 11;
  expect(await registry.sweep()).toBe(1);
  expect(value.close).toHaveBeenCalledOnce();
});
it('extracts exact stable claims and fails closed on missing or malformed identity', () => {
  const auth = {
    token: 'old',
    scopes: [],
    clientId: 'client',
    extra: { sub: ' subject ', organizationId: 'org' },
  };
  expect(sessionOwner(auth)).toEqual({
    sub: ' subject ',
    clientId: 'client',
    organizationId: 'org',
  });
  expect(sessionOwner({ ...auth, token: 'refreshed', expiresAt: 9999999999 })).toEqual(
    sessionOwner(auth),
  );
  expect(sessionOwner({ ...auth, extra: { sub: 'subject' } })?.organizationId).toBeNull();
  for (const extra of [
    {},
    { sub: '' },
    { sub: 1 },
    { sub: 'subject', organizationId: null },
    { sub: 'subject', organizationId: '' },
  ]) {
    expect(sessionOwner({ ...auth, extra })).toBeUndefined();
  }
  expect(sessionOwner({ ...auth, clientId: '' })).toBeUndefined();
  expect(sessionOwner(undefined)).toBeUndefined();
});
