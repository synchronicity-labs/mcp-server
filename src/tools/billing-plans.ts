import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

/**
 * billing-plans_list tells an agent what the organization can buy and what each option
 * costs (GET /v2/billing/plans), so the person sees plans and prices in the chat instead
 * of being sent to the website. It only reads. Buying is billing-payment-links_create
 * (the agent's wallet pays) or billing-approval-links_create (a person pays).
 */
export const PLANS_TOOL = 'billing-plans_list';
const PLANS_PATH = '/v2/billing/plans';

const plan = z.object({
  id: z.string().describe('Plan id to pass as plan to a payment or approval link.'),
  name: z.string().describe('Plan name to show the person.'),
  amountCents: z.number().int().describe('Price in cents for each interval.'),
  currency: z.string().describe('Currency of amountCents, such as usd.'),
  interval: z.string().describe('How often the plan renews, such as month.'),
  monthlyCredits: z
    .number()
    .int()
    .nullable()
    .describe('Credits the plan grants each month; null for a plan that is not credit-billed.'),
  limits: z
    .object({
      maxOutputDurationSeconds: z.number().nullable().optional(),
      concurrency: z.number().int().nullable().optional(),
    })
    .describe('Longest output in seconds and generations at once on this plan.'),
  change: z
    .string()
    .describe(
      'current: the plan they are on. subscribe: a first paid plan. upgrade: a higher plan. unavailable: cannot be bought here; see unavailableReason.',
    ),
  unavailableReason: z
    .string()
    .nullable()
    .describe('Why an unavailable plan cannot be bought, as an error code; null otherwise.'),
});

const plans = z.object({
  organization: z
    .object({ id: z.string(), name: z.string().nullable() })
    .describe('The organization these plans and prices are for.'),
  billingModel: z
    .string()
    .describe('How the organization is billed, as account_get-context has it.'),
  currentPlan: z
    .object({ id: z.string(), name: z.string() })
    .describe('The plan the organization is on now.'),
  plans: z.array(plan).describe('Every plan this organization could be on, cheapest first.'),
  credits: z
    .object({
      minCredits: z.number().int(),
      maxCredits: z.number().int(),
      centsPerCredit: z.number(),
      currency: z.string(),
    })
    .nullable()
    .describe('One-time credit top-ups and their price each; null when it cannot buy credits now.'),
  agentPayments: z
    .boolean()
    .describe(
      'Whether a wallet can pay here through billing-payment-links_create. When false, a person pays through billing-approval-links_create.',
    ),
});

const DESCRIPTION =
  "List the plans the organization can buy, with each price, what it includes and whether credits can be topped up, so the person can choose in the chat without visiting the website. It is for the session's organization unless you pass organizationId. " +
  'Use it when the person asks about plans, prices, upgrading or buying credits, and before you suggest a plan after a refusal with nextAction.type upgrade_plan or buy_credits. ' +
  'Not for the current plan or balance alone (account_get-context, account_get-usage), the cost of one generation (generations_estimate-cost), or what a past generation cost (generations_get-costs).\n\n' +
  'Effects: it only reads. Nothing is charged, held or changed.\n\n' +
  'Show the plans with change subscribe or upgrade, each with its price per interval, and say that a plan renews. Do not push a plan: answer what was asked, or name the cheapest one that unblocks a refused request. ' +
  'To buy, after the person says yes: billing-payment-links_create when agentPayments is true and you have a payment wallet, otherwise billing-approval-links_create and give the person its url. Pass the plan id, or credits within minCredits and maxCredits.\n\n' +
  'Returns: organization, billingModel, currentPlan, plans (id, name, amountCents, currency, interval, monthlyCredits, limits, change, unavailableReason), credits and agentPayments.';

export function createBillingPlansTools(http: HttpClient): McpToolDefinition[] {
  return [
    {
      name: PLANS_TOOL,
      title: 'List plans and prices',
      description: DESCRIPTION,
      inputSchema: {},
      outputSchema: plans.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (_args, context) => {
        try {
          return plans.parse(await http.request('get', PLANS_PATH, { signal: context?.signal }));
        } catch (error) {
          // An API from before this route answers like any unknown path.
          if (error instanceof ApiRequestError && error.status === 404)
            throw new Error(
              'This sync. API does not list plans yet. Ask for the price of one plan or credit amount with billing-approval-links_create, which quotes it without charging.',
              { cause: error },
            );
          throw error;
        }
      },
    },
  ];
}
