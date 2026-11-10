import { afterEach, expect, it } from 'vitest';
import { ACME, api, cleanUp, HOME, hosted } from './test-fixtures/organizations.js';

afterEach(cleanUp);

it('reads another organization’s billing and usage without switching the session', async () => {
  const { baseUrl, calls } = await api({
    intercept: (request) => {
      if (request.url === '/v2/billing')
        return [
          200,
          {
            plan: 'scale',
            canManageBilling: true,
            credits: null,
            freeMonthlyLimits: null,
          },
        ];
      if (request.url === '/v2/usage/totals-with-completeness')
        return [
          200,
          {
            isComplete: true,
            items: [{ totalGenerationsAmountBilledCents: 42, totalFramesCount: 100 }],
          },
        ];
      return undefined;
    },
  });
  const { call } = await hosted(baseUrl);
  const usage = await call('account_get-usage', { organizationId: ACME.id });
  expect(usage.isError).not.toBe(true);
  expect(usage.structuredContent).toMatchObject({
    organization: ACME,
    plan: 'scale',
    canManageBilling: false,
    usage: { totalCostCents: 42, totalFrames: 100, totalTtsSeconds: 0 },
  });
  const reads = calls.filter((request) =>
    ['/v2/oauth/account', '/v2/billing', '/v2/usage/totals-with-completeness'].includes(
      request.url,
    ),
  );
  expect(reads.map(({ url, organization }) => ({ url, organization }))).toEqual([
    { url: '/v2/oauth/account', organization: ACME.id },
    { url: '/v2/billing', organization: ACME.id },
    { url: '/v2/usage/totals-with-completeness', organization: ACME.id },
  ]);

  calls.length = 0;
  const context = await call('account_get-context');
  expect(context.structuredContent).toMatchObject({
    organization: HOME,
    organizationChoice: { selectedBy: 'credential' },
  });
  expect(calls.every((request) => request.organization === undefined)).toBe(true);
});
