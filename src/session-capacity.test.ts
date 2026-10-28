import { expect, it, vi } from 'vitest';
import { SessionRegistry } from './session-registry.js';

const owner = { sub: 'subject', clientId: 'client', organizationId: 'org' };
const transport = () => ({ close: vi.fn(async () => undefined) });

it('reclaims the oldest idle session at capacity without interrupting active or recent work', () => {
  let now = 0;
  const registry = new SessionRegistry({ idleTtlMs: 120_000, maxSessions: 3, now: () => now });
  const running = transport();
  const idle = transport();
  const recent = transport();
  const lease = registry.reserve()!.commit('running', running, owner);
  registry.reserve()!.commit('idle', idle, owner).release();
  now = 31_000;
  registry.reserve()!.commit('recent', recent, owner).release();
  const next = registry.reserve();
  expect(next).toBeDefined();
  expect(registry.acquire('idle', owner)).toBeUndefined();
  expect(idle.close).toHaveBeenCalledOnce();
  expect(running.close).not.toHaveBeenCalled();
  expect(recent.close).not.toHaveBeenCalled();
  expect(registry.stats()).toMatchObject({ evicted: 1, rejected: 0 });
  next!.release();
  lease.release();
});

it('expires sessions during admission and refuses to revive an expired session between sweeps', () => {
  let now = 0;
  const registry = new SessionRegistry({ idleTtlMs: 120_000, maxSessions: 2, now: () => now });
  const first = transport();
  const second = transport();
  registry.reserve()!.commit('first', first, owner).release();
  registry.reserve()!.commit('second', second, owner).release();
  now = 120_001;
  expect(registry.acquire('first', owner)).toBeUndefined();
  const reservation = registry.reserve();
  expect(reservation).toBeDefined();
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
  expect(registry.stats()).toMatchObject({ active: 0, expired: 2, rejected: 0 });
  reservation!.release();
});

it('distinguishes capacity and memory rejection and protects initialization reservations', () => {
  let healthy = true;
  const registry = new SessionRegistry({
    idleTtlMs: 120_000,
    maxSessions: 1,
    canAdmit: () => healthy,
  });
  const pending = registry.reserve()!;
  expect(registry.reserve()).toBeUndefined();
  pending.release();
  healthy = false;
  expect(registry.reserve()).toBeUndefined();
  expect(registry.stats()).toMatchObject({ rejected: 2, rejectedCapacity: 1, rejectedMemory: 1 });
});

it('sustains fresh sessions at five times incident traffic for 45 simulated minutes without client DELETE', async () => {
  let now = 0;
  const registry = new SessionRegistry({ idleTtlMs: 120_000, maxSessions: 1000, now: () => now });
  // A long-running request remains protected across every idle expiry and sweep.
  const running = transport();
  const active = registry.reserve()!.commit('long-request', running, owner);
  for (let index = 0; index < 7200; index++) {
    const reservation = registry.reserve();
    expect(reservation).toBeDefined();
    reservation!.commit(`call-${index}`, transport(), owner).release();
    now += 375;
    if (index % 40 === 0) await registry.sweep();
    expect(registry.size).toBeLessThan(365);
  }
  expect(registry.stats().rejected).toBe(0);
  expect(running.close).not.toHaveBeenCalled();
  active.release();
  now += 120_001;
  await registry.sweep();
  expect(registry.size).toBe(0);
});
