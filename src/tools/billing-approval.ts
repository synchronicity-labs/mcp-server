import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import { APPROVAL_LINKS_OPERATION_ID, APPROVAL_LINKS_PATH } from '../openapi/parser.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';

/**
 * An agent cannot pay. billing-approval-links_create asks the API for a sync.so page where
 * a person approves and pays for a plan or credits (POST /v2/billing/approval-links). The
 * API stores nothing and charges nothing for the link. The tool exists only when the
 * connected API publishes the operation, so an older API simply lists no tool.
 */
export function billingApprovalOperation(operation: ParsedOperation): boolean {
  return (
    operation.operationId === APPROVAL_LINKS_OPERATION_ID &&
    operation.method === 'post' &&
    operation.path === APPROVAL_LINKS_PATH
  );
}

const input = z
  .object({
    plan: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Plan to subscribe or upgrade to: requiredPlan (or nextAction.requiredPlan) from the refusal, or the plan the user asked for. Credit-billed organizations buy hobby, starter, pro or team; others buy hobbyist, creator, growth or scale. Send plan or credits, not both.',
      ),
    credits: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Credits to buy, 500 to 50,000: requiredCredits from the refusal (at least 500), or the amount the user asked for. Only organizations billed in credits can buy them. Send plan or credits, not both.',
      ),
  })
  .strict();

const planSummary = z.object({
  id: z.string().describe('Plan id.'),
  name: z.string().describe('Plan name to show the person.'),
});

const link = z.object({
  id: z.string().describe('Link id.'),
  url: z
    .string()
    .describe(
      'Page on sync.so to give the person, verbatim. They sign in, review and pay there; it does not expire.',
    ),
  organization: z
    .object({ id: z.string(), name: z.string().nullable() })
    .describe('The organization that pays and receives the plan or credits.'),
  kind: z.string().describe('plan or credits.'),
  change: z
    .string()
    .describe(
      'subscribe: a first paid plan, paid at checkout. upgrade: charged to the card on file when approved. top_up: a one-time credit purchase.',
    ),
  plan: planSummary.nullable().describe('The plan being approved; null for credits.'),
  credits: z.number().int().nullable().describe('Credits being bought; null for a plan.'),
  amountCents: z
    .number()
    .int()
    .describe('Price in cents: the plan price per interval, or the credits’ one-time price.'),
  currency: z.string().describe('Currency of amountCents, such as usd.'),
  interval: z.string().nullable().describe('month or year for a plan; null for credits.'),
  currentPlan: planSummary.describe('The organization’s plan before approval.'),
});

const DESCRIPTION =
  "Create a sync.so link where a person approves and pays for a plan or a credit top-up for the session's organization, because you cannot pay. " +
  'Use it when a Sync refusal has nextAction.type upgrade_plan (pass plan: its requiredPlan) or buy_credits (pass credits: requiredCredits), or when the user asks to upgrade their plan or buy credits. ' +
  'Not for an unpaid invoice, a declined card or a payment to confirm (give the person nextAction.url instead), and not to read the current plan or balance (account_get-context, account_get-usage).\n\n' +
  'Effects: it creates no charge, subscription or payment and holds nothing. Each call returns a new link that does not expire, so reuse one you already have instead of creating another.\n\n' +
  'Give url to the person verbatim: they open it in a browser, sign in, review the plan or credits, price and organization, and approve and pay there. Only owners and admins of the organization can approve. After they say they have approved, account_get-context shows the new plan and account_get-usage the new credit balance; check them before retrying the refused request.\n\n' +
  'Send exactly one of plan or credits. Refusals: 409 already_on_plan (it already has that plan or a higher one, so nothing is due), approval_credits_unavailable (credits need a paid credit plan first) or billing_managed_by_sync (custom agreement: contact sync.); 400 approval_plan_unavailable (this organization cannot buy that plan); 402 account_on_hold.\n\n' +
  'Returns: id, url, organization, kind, change (subscribe, upgrade or top_up), plan or credits, amountCents with currency, interval for a plan, and currentPlan.';

export function createBillingApprovalTools(
  operations: ParsedOperation[],
  http: HttpClient,
): McpToolDefinition[] {
  if (!operations.some(billingApprovalOperation)) return [];
  return [
    {
      name: 'billing-approval-links_create',
      title: 'Create a plan or credits approval link',
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
            'Send exactly one of plan or credits: plan for an upgrade, credits for a top-up.',
          );
        return link.parse(
          await http.request('post', APPROVAL_LINKS_PATH, { body, signal: context?.signal }),
        );
      },
    },
  ];
}
