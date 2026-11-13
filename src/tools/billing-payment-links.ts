import { z } from 'zod';
import type { ClientProfile } from '../client-profile.js';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

/**
 * An agent with a payment wallet pays for a plan or credits itself. The wallet makes the
 * paying request, so billing-payment-links_create asks the API for a short-lived URL that
 * carries no sync. credential (POST /v2/billing/payment-links): the agent hands that URL to
 * its wallet and nothing secret passes through the model. The API charges nothing for the
 * link. An agent without a wallet uses billing-approval-links_create instead.
 */
export const PAYMENT_LINK_TOOL = 'billing-payment-links_create';
const PAYMENT_LINKS_PATH = '/v2/billing/payment-links';

/**
 * App directories keep purchases out of their apps: OpenAI's rules for ChatGPT (and Codex
 * through the same listing) and Anthropic's for Claude.ai. Those clients neither list this
 * tool nor may call it; they have no wallet to pay with either. Coding agents reach the
 * server as the generic profile.
 */
export const paysInClient = (profile: ClientProfile) => profile.name === 'generic';

export const PAYMENT_UNAVAILABLE_IN_CLIENT =
  'Paying for a plan or credits is not available in this client. The person manages their plan at https://sync.so/billing.';

const input = z
  .object({
    plan: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Credit plan to start: hobby, starter, pro or team, as requiredPlan (or nextAction.requiredPlan) from a refusal names it, or as the user asked. Only for an organization without a paid plan. Send plan or credits, not both.',
      ),
    credits: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Credits to buy, 500 to 50,000: requiredCredits from the refusal (at least 500), or the amount the user asked for. Only for an organization on a paid credit plan. Send plan or credits, not both.',
      ),
  })
  .strict();

const link = z.object({
  url: z
    .string()
    .describe(
      'URL the wallet pays with a POST and no sync. credential. Pass it to the wallet verbatim; never fetch it yourself to pay.',
    ),
  expiresAt: z.string().describe('When the link stops working. Create a new one after that.'),
  kind: z.string().describe('plan or credits.'),
  plan: z.string().nullable().describe('The plan being started; null for credits.'),
  credits: z.number().int().nullable().describe('Credits being bought; null for a plan.'),
  amountCents: z
    .number()
    .int()
    .describe('Price in cents: each month for a plan, once for credits. The wallet pays this.'),
  currency: z.string().describe('Currency of amountCents, such as usd.'),
  interval: z
    .string()
    .nullable()
    .describe(
      'month for a plan, which the wallet must be allowed to pay monthly; null for credits.',
    ),
  networkId: z
    .string()
    .describe('sync.’s Stripe network id, which a wallet needs to prepare a recurring token.'),
  organization: z
    .object({ id: z.string(), name: z.string().nullable() })
    .describe('The organization that receives the plan or credits.'),
});

const DESCRIPTION =
  'Create a link your payment wallet pays to start a plan or buy credits for the organization, when you have a wallet that pays Machine Payments Protocol URLs with a Stripe shared payment token, such as Link CLI. ' +
  'Use it when the user asks you to pay for a plan or credits, or a Sync refusal has nextAction.type upgrade_plan or buy_credits and the user has let you spend. ' +
  'Without such a wallet, or when the user would rather pay themselves, use billing-approval-links_create. Not for changing or cancelling an existing paid plan, an unpaid invoice or a declined card.\n\n' +
  'Effects: creating the link charges nothing. Paying it charges the wallet: once for credits, and for a plan now and again every month until the person revokes the wallet’s token, which ends the plan at the end of the paid month. Say the price and, for a plan, that it renews monthly, and get the user’s go-ahead before paying.\n\n' +
  'How to pay: the wallet sends a POST to url; give it nothing else from sync. With Link CLI, credits are `link-cli mpp pay <url> --method POST --context "<what and why, 100+ characters>"`. A plan needs a monthly token first: `link-cli spend-request create --credential-type shared_payment_token --network-id <networkId> --amount <amountCents> --currency <currency> --recurring-interval month --context "<…>"`, have the person approve it, then `link-cli mpp pay <url> --method POST --spend-request-id <id>`. ' +
  'Afterwards account_get-context shows the plan and account_get-usage the credits, within seconds; check before retrying the refused request. The link works for an hour, until expiresAt; after that the wallet gets 410 payment_link_invalid, so create a new one.\n\n' +
  'Send exactly one of plan or credits. Refusals: 403 machine_payments_unavailable or not an owner or admin; 409 already_on_plan, approval_plan_unavailable (this organization cannot buy that plan) or approval_credits_unavailable (credits need a paid credit plan first); 402 account_on_hold.\n\n' +
  'Returns: url, expiresAt, kind, plan or credits, amountCents with currency, interval, networkId and organization.';

export function createBillingPaymentLinkTools(http: HttpClient): McpToolDefinition[] {
  return [
    {
      name: PAYMENT_LINK_TOOL,
      title: 'Create a link your wallet pays for a plan or credits',
      description: DESCRIPTION,
      inputSchema: input.shape,
      outputSchema: link.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: async (args, context) => {
        const body = input.parse(args);
        if ((body.plan === undefined) === (body.credits === undefined))
          throw new Error(
            'Send exactly one of plan or credits: plan to start a plan, credits for a top-up.',
          );
        return link.parse(
          await http.request('post', PAYMENT_LINKS_PATH, { body, signal: context?.signal }),
        );
      },
    },
  ];
}
