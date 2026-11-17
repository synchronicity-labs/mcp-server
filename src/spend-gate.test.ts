import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from './http-client.js';
import { chosenOrganization, OrganizationSession } from './organization-selection.js';
import { type AskUser, canBeCharged, createSpendGate } from './spend-gate.js';

const free = { plan: null, hasActiveCredits: false, elevenLabsKeyConnected: false, credits: null };

describe('canBeCharged', () => {
  it('is false only for an organization with no plan, credits or provider key', () => {
    expect(canBeCharged(free)).toBe(false);
    expect(canBeCharged({ ...free, credits: { balance: 0 } })).toBe(false);
  });

  it.each([
    ['a plan', { ...free, plan: 'creator' }],
    ['active credits', { ...free, hasActiveCredits: true }],
    ['a credit balance', { ...free, credits: { balance: 12 } }],
    ['a connected provider key', { ...free, elevenLabsKeyConnected: true }],
    ['no credits field', { plan: null, elevenLabsKeyConnected: false }],
    ['no provider key field', { plan: null, hasActiveCredits: false }],
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
    expect(await check('lipsync_create', {}, ask)).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks before chargeable work and runs it once approved', async () => {
    const { check } = gate({}, { ...free, plan: 'creator' });
    const ask = approve();
    expect(await check('lipsync_create', {}, ask)).toBeUndefined();
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
      isError: true,
      structuredContent: { error: { code: 'SPEND_NOT_APPROVED' } },
    });
  });

  it('refuses when the question cannot be asked', async () => {
    const { check } = gate({}, { ...free, plan: 'creator' });
    const result = await check('dubbing_create', {}, async () => {
      throw new Error('timed out');
    });
    expect(result).toMatchObject({
      structuredContent: { error: { code: 'APPROVAL_UNAVAILABLE' } },
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
      structuredContent: { error: { code: 'ORGANIZATION_SWITCH_NOT_APPROVED' } },
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
