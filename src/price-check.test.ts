import { describe, expect, it, vi } from 'vitest';
import { resolveClientProfile } from './client-profile.js';
import type { HttpClient } from './http-client.js';
import { ORGANIZATION_HEADER } from './organization-selection.js';
import { FREE_PLAN_REFUSAL_NEXT_STEP, withPriceCheck } from './price-check.js';
import type { McpToolDefinition } from './tools/generator.js';

const ORGANIZATION = '00000000-0000-4000-8000-000000000002';
const estimate = {
  name: 'generations_estimate-cost',
  description: 'Estimate',
  inputSchema: {},
  handler: async () => ({ estimatedGenerationCost: 0.91, organization: { id: ORGANIZATION } }),
} as unknown as McpToolDefinition;

const freeBilling = (overrides: Record<string, unknown> = {}) => ({
  plan: null,
  freeGenerationsExhausted: true,
  freeDubbingExhausted: false,
  freeMonthlyLimits: {
    generations: { used: 3, max: 3 },
    dubbing: { used: 0, max: 1 },
    monthlyResetDate: '2026-12-01T00:00:00.000Z',
  },
  ...overrides,
});

function quote(billing: unknown | Error, args: Record<string, unknown> = {}) {
  const request = vi.fn<HttpClient['request']>(async () => {
    if (billing instanceof Error) throw billing;
    return billing;
  });
  const tool = withPriceCheck(estimate, { request } as unknown as HttpClient);
  const result = tool.handler(
    { model: 'sync-3', duration: 10, ...args },
    { clientProfile: resolveClientProfile('claude') },
  ) as Promise<Record<string, unknown>>;
  return { result, request };
}

const createCall = {
  tool: 'lipsync_create',
  arguments: { model: 'sync-3', video: { url: 'https://example.test/v.mp4' } },
};

describe('a quote the free plan cannot run', () => {
  it('says the API would refuse it and drops the Create button', async () => {
    const { result } = quote(freeBilling(), { create: createCall });
    await expect(result).resolves.toMatchObject({
      estimatedGenerationCost: 0.91,
      admission: {
        allowed: false,
        reason: 'free_generations_used',
        used: 3,
        limit: 3,
        resetsAt: '2026-12-01T00:00:00.000Z',
        nextStep: FREE_PLAN_REFUSAL_NEXT_STEP,
      },
    });
    expect(await result).not.toHaveProperty('create');
  });

  it('uses the dubbing allowance for translate-and-dub', async () => {
    const dub = { workflow: 'translate-and-dub' };
    await expect(quote(freeBilling(), dub).result).resolves.not.toHaveProperty('admission');
    await expect(
      quote(freeBilling({ freeDubbingExhausted: true }), dub).result,
    ).resolves.toMatchObject({ admission: { reason: 'free_dubbing_used', used: 0, limit: 1 } });
  });

  it('reads billing for the organization the quote names', async () => {
    const { result, request } = quote(freeBilling(), { organizationId: ORGANIZATION });
    await result;
    expect(request.mock.calls[0]?.[2]?.headers).toEqual({ [ORGANIZATION_HEADER]: ORGANIZATION });
  });

  it.each([
    ['a paid plan', freeBilling({ plan: 'creator' })],
    ['free generations left', freeBilling({ freeGenerationsExhausted: false })],
    ['a failed billing read', new Error('unavailable')],
  ])('adds nothing for %s', async (_, billing) => {
    const { result } = quote(billing, { create: createCall });
    const quoted = await result;
    expect(quoted).not.toHaveProperty('admission');
    expect(quoted).toHaveProperty('create');
  });
});
