import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from './http-client.js';
import { chosenOrganization, OrganizationSession } from './organization-selection.js';
import {
  type AskUser,
  assertCheckedOrganization,
  canBeCharged,
  createSpendGate,
  OrganizationChangedError,
} from './spend-gate.js';

const free = { plan: null, hasActiveCredits: false, elevenLabsKeyConnected: false, credits: null };

describe('canBeCharged', () => {
  it('is false only for an organization with no plan, credits or provider key', () => {
    expect(canBeCharged(free)).toBe(false);
    expect(canBeCharged({ ...free, credits: { balance: 0 } })).toBe(false);
  });

  it("is false for the API's free-tier answer, which has no credits block at all", () => {
    // sync-api-v2 billing.controller.ts: "The `credits` block is intentionally absent".
    expect(
      canBeCharged({
        plan: null,
        hasActiveCredits: false,
        elevenLabsKeyConnected: false,
        freeGenerationsExhausted: false,
        freeMonthlyLimits: { generations: { used: 1, max: 3 } },
      }),
    ).toBe(false);
  });

  it.each([
    ['a plan', { ...free, plan: 'creator' }],
    ['active credits', { ...free, hasActiveCredits: true }],
    ['a credit balance', { ...free, credits: { balance: 12 } }],
    ['a connected provider key', { ...free, elevenLabsKeyConnected: true }],
    ['no hasActiveCredits field', { plan: null, elevenLabsKeyConnected: false }],
    ['no provider key field', { plan: null, hasActiveCredits: false }],
    ['no plan field', { hasActiveCredits: false, elevenLabsKeyConnected: false }],
    ['an unreadable answer', 'oops'],
  ])('is true with %s', (_label, account) => {
    expect(canBeCharged(account)).toBe(true);
  });
});

function gate(accounts: Record<string, unknown> = {}, fallback: unknown = free) {
  const reads: Array<string | undefined> = [];
  const http = {
    request: vi.fn(async () => {
      const organization = chosenOrganization()?.id;
      reads.push(organization);
      const account = organization ? (accounts[organization] ?? fallback) : fallback;
      if (account instanceof Error) throw account;
      return account;
    }),
  } as unknown as HttpClient;
  const session = new OrganizationSession();
  return { reads, session, check: createSpendGate({ http, session }) };
}

const asked = (answer: Awaited<ReturnType<AskUser>>) => vi.fn<AskUser>(async () => answer);
const approve = () => asked({ action: 'accept', content: { approve: true } });

describe('paid tools', () => {
  it('lets free-tier work run without asking', async () => {
    const { check } = gate();
    const ask = approve();
    expect(await check('lipsync_create', {}, ask)).toMatchObject({ within: expect.any(Function) });
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks before chargeable work and runs it once approved', async () => {
    const { check } = gate({}, { ...free, plan: 'creator' });
    const ask = approve();
    expect(await check('lipsync_create', {}, ask)).toMatchObject({ within: expect.any(Function) });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0].message).toContain('a lipsync generation');
  });

  it.each([
    ['declines', { action: 'decline' as const }],
    ['cancels', { action: 'cancel' as const }],
    ['accepts without ticking approve', { action: 'accept' as const, content: { approve: false } }],
  ])('refuses when the person %s', async (_label, answer) => {
    const { check } = gate({}, { ...free, plan: 'creator' });
    const result = await check('voices_clone', {}, asked(answer));
    expect(result).toMatchObject({
      refusal: { isError: true, structuredContent: { error: { code: 'SPEND_NOT_APPROVED' } } },
    });
  });

  it('refuses when the question cannot be asked', async () => {
    const { check } = gate({}, { ...free, plan: 'creator' });
    const result = await check('dubbing_create', {}, async () => {
      throw new Error('timed out');
    });
    expect(result).toMatchObject({
      refusal: { structuredContent: { error: { code: 'APPROVAL_UNAVAILABLE' } } },
    });
  });

  it('asks when the account cannot be read', async () => {
    const { check } = gate({}, new Error('503'));
    const ask = approve();
    await check('lipsync_create', {}, ask);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("checks the organization the call names, not the session's", async () => {
    const paid = '00000000-0000-4000-8000-0000000000aa';
    const { check, reads } = gate({ [paid]: { ...free, plan: 'scale' } });
    const ask = approve();
    await check('lipsync_create', { organizationId: paid }, ask);
    expect(reads).toEqual([paid]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks once for a job set, checking each organization it runs in', async () => {
    const paid = '00000000-0000-4000-8000-0000000000bb';
    const { check, reads } = gate({ [paid]: { ...free, plan: 'scale' } });
    const ask = approve();
    await check(
      'jobs_create-many',
      { tool: 'lipsync_create', items: [{}, { organizationId: paid }, { organizationId: paid }] },
      ask,
    );
    expect(new Set(reads)).toEqual(new Set([paid, undefined]));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0].message).toContain('3 jobs with lipsync_create');
  });

  it('does not ask for a batch dry run, or for tools that cost nothing', async () => {
    const { check } = gate({}, { ...free, plan: 'creator' });
    const ask = approve();
    expect(await check('batches_create', { dryRun: true, items: [] }, ask)).toBeUndefined();
    expect(await check('projects_create', {}, ask)).toBeUndefined();
    expect(await check('shots_splice', {}, ask)).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('the organizations a call runs in', () => {
  it('checks only the organizations a job set names, not the session it was sent from', async () => {
    const freeOrg = '00000000-0000-4000-8000-0000000000dd';
    const { check, reads, session } = gate({ paid: { ...free, plan: 'scale' } });
    session.select({ id: 'paid', name: 'Paid' }, undefined);
    const ask = approve();
    await check(
      'jobs_create-many',
      { tool: 'lipsync_create', items: [{ organizationId: freeOrg }, { organizationId: freeOrg }] },
      ask,
    );
    expect(reads).toEqual([freeOrg]);
    expect(ask).not.toHaveBeenCalled();
  });

  it('refuses to run approved work after the session switched organization', async () => {
    const { check, session } = gate({}, { ...free, plan: 'creator' });
    session.select({ id: 'approved', name: 'Approved' }, undefined);
    const decision = await check('lipsync_create', {}, approve());
    if (!decision || !('within' in decision)) throw new Error('expected approval');
    expect(() => decision.within(() => assertCheckedOrganization(session))).not.toThrow();
    session.select({ id: 'other', name: 'Other' }, undefined);
    expect(() => decision.within(() => assertCheckedOrganization(session))).toThrow(
      OrganizationChangedError,
    );
    // Outside a checked call there is nothing to compare against.
    expect(() => assertCheckedOrganization(session)).not.toThrow();
  });

  it('keeps an approved call running when the session only learns its default organization', async () => {
    const { check, session } = gate({}, { ...free, plan: 'creator' });
    const decision = await check(
      'jobs_create-many',
      { tool: 'lipsync_create', items: [{}, {}] },
      approve(),
    );
    if (!decision || !('within' in decision)) throw new Error('expected approval');
    // The first item reads the credential's default; that is not a switch.
    session.rememberDefault({ id: 'default-org', name: 'Default' });
    expect(() => decision.within(() => assertCheckedOrganization(session))).not.toThrow();
  });

  it('treats selecting the organization already selected as no switch', async () => {
    const { check, session } = gate({}, { ...free, plan: 'creator' });
    session.select({ id: 'a', name: 'A' }, undefined);
    const decision = await check('lipsync_create', {}, approve());
    if (!decision || !('within' in decision)) throw new Error('expected approval');
    session.select({ id: 'a', name: 'A' }, undefined);
    expect(() => decision.within(() => assertCheckedOrganization(session))).not.toThrow();
    session.select({ id: 'b', name: 'B' }, undefined);
    expect(() => decision.within(() => assertCheckedOrganization(session))).toThrow(
      OrganizationChangedError,
    );
  });

  it('stops when the call is cancelled during the account read, instead of asking', async () => {
    const controller = new AbortController();
    const http = {
      request: vi.fn(async (_method: string, _path: string, options?: { signal?: AbortSignal }) => {
        controller.abort();
        options?.signal?.throwIfAborted();
        return free;
      }),
    } as unknown as HttpClient;
    const check = createSpendGate({ http, session: new OrganizationSession() });
    const ask = approve();
    await expect(check('lipsync_create', {}, ask, controller.signal)).rejects.toThrow();
    expect(http.request).toHaveBeenCalledWith('get', '/v2/billing', { signal: controller.signal });
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('organization switch', () => {
  const other = '00000000-0000-4000-8000-0000000000cc';

  it('asks before switching, even on the free tier', async () => {
    const { check } = gate();
    const ask = approve();
    expect(await check('organizations_select', { organizationId: other }, ask)).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0].message).toContain(other);
  });

  it('refuses a switch the person does not approve', async () => {
    const { check } = gate();
    const result = await check(
      'organizations_select',
      { organizationId: other },
      asked({ action: 'decline' }),
    );
    expect(result).toMatchObject({
      refusal: { structuredContent: { error: { code: 'ORGANIZATION_SWITCH_NOT_APPROVED' } } },
    });
  });

  it('does not ask to "switch" to the organization already in use', async () => {
    const { check, session } = gate();
    session.select({ id: other, name: 'Studio' }, undefined);
    const ask = approve();
    expect(await check('organizations_select', { organizationId: other }, ask)).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });
});
