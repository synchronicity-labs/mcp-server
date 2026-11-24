import { describe, expect, it, vi } from 'vitest';
import { resolveClientProfile } from './client-profile.js';
import { ApiRequestError, type HttpClient } from './http-client.js';
import { ORGANIZATION_HEADER } from './organization-selection.js';
import { withPriceCheck } from './price-check.js';
import { createToolErrorResult } from './server.js';
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

function quote(billing: unknown, args: Record<string, unknown> = {}) {
  const request = vi.fn<HttpClient['request']>(async () => {
    if (billing instanceof Error) throw billing;
    return billing;
  });
  const tool = withPriceCheck(estimate, { request } as unknown as HttpClient);
  const result = Promise.resolve(
    tool.handler(
      { model: 'sync-3', duration: 10, ...args },
      { clientProfile: resolveClientProfile('claude') },
    ),
  ) as Promise<Record<string, unknown>>;
  return { result, request };
}

const createCall = {
  tool: 'lipsync_create',
  arguments: { model: 'sync-3', video: { url: 'https://example.test/v.mp4' } },
};

async function refusal(result: Promise<unknown>): Promise<ApiRequestError> {
  const error = await result.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ApiRequestError);
  return error as ApiRequestError;
}

describe('a quote the free plan cannot run', () => {
  it('returns the refusal the create call would get, with its next action', async () => {
    const error = await refusal(quote(freeBilling(), { create: createCall }).result);
    expect(error).toMatchObject({
      status: 402,
      code: 'free_tier_generations_exhausted',
      details: {
        nextAction: { type: 'upgrade_plan', url: 'https://sync.so/billing/subscription' },
      },
    });
    expect(error.message).toContain('all 3 free generations');
    expect(error.message).toContain('2026-12-01');
  });

  it('names no billing tool to ChatGPT, which does not list them', async () => {
    const error = await refusal(quote(freeBilling()).result);
    const text = JSON.stringify(createToolErrorResult(error, undefined, true).structuredContent);
    expect(text).toContain('/billing/subscription');
    expect(text).not.toContain('billing-plans_list');
    expect(text).not.toContain('billing-approval-links_create');
  });

  it('uses the dubbing allowance for translate-and-dub', async () => {
    const dub = { workflow: 'translate-and-dub' };
    await expect(quote(freeBilling(), dub).result).resolves.toMatchObject({
      estimatedGenerationCost: 0.91,
    });
    const error = await refusal(quote(freeBilling({ freeDubbingExhausted: true }), dub).result);
    expect(error.message).toContain('all 1 free dubs');
  });

  it('reads billing for the organization the quote names', async () => {
    const { result, request } = quote(freeBilling(), { organizationId: ORGANIZATION });
    await result.catch(() => undefined);
    expect(request.mock.calls[0]?.[2]?.headers).toEqual({ [ORGANIZATION_HEADER]: ORGANIZATION });
  });

  it.each([
    ['a paid plan', freeBilling({ plan: 'creator' })],
    ['free generations left', freeBilling({ freeGenerationsExhausted: false })],
    ['a failed billing read', new Error('unavailable')],
  ])('prices the job as before for %s', async (_, billing) => {
    const quoted = await quote(billing, { create: createCall }).result;
    expect(quoted).toMatchObject({ estimatedGenerationCost: 0.91 });
    expect(quoted).toHaveProperty('create');
  });
});
