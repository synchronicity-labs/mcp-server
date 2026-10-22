import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { McpToolDefinition } from './generator.js';

const counter = z.object({
  used: z.number().finite().nonnegative(),
  max: z.number().finite().nonnegative(),
});
const billing = z.object({
  plan: z.string().nullable(),
  canManageBilling: z.boolean(),
  credits: z
    .object({
      balance: z.number().finite(),
      available: z.number().finite(),
      inFlight: z.number().finite(),
    })
    .nullish(),
  freeMonthlyLimits: z
    .object({ generations: counter, tts: counter, monthlyResetDate: z.string().datetime() })
    .nullable(),
});
const usage = z.object({
  totalCostCents: z.number().finite(),
  totalFrames: z.number().finite().nonnegative(),
  totalTtsSeconds: z.number().finite().nonnegative(),
});
const response = billing.extend({
  credits: billing.shape.credits.unwrap().nullable(),
  usage: usage.nullable(),
});
const totals = z.object({
  isComplete: z.boolean(),
  items: z.array(
    z.union([
      z.object({
        totalGenerationsAmountBilledCents: z.number().finite(),
        totalFramesCount: z.number().finite().nonnegative(),
      }),
      z.object({
        totalIntegrationsAmountBilledCents: z.number().finite(),
        totalSecondsGenerated: z.number().finite().nonnegative(),
      }),
    ]),
  ),
});
const rename = z.object({ projectId: z.uuid(), name: z.string().trim().min(1).max(255) });
const project = z.object({ id: z.uuid(), name: z.string() });

export function createAccountManagementTools(http: HttpClient): McpToolDefinition[] {
  return [
    {
      name: 'get-account-usage',
      title: 'Read Sync usage and balance',
      description:
        'Read the connected organization’s available credits, free allowance, or complete billed usage for the current period. Does not purchase credits, change plans, or start generation.',
      inputSchema: {},
      outputSchema: response.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      handler: async (_args, context) => {
        const identity = z
          .object({ organization: z.object({ role: z.string() }) })
          .parse(await http.request('get', '/v2/oauth/account', { signal: context?.signal }));
        const info = billing.parse(
          await http.request('get', '/v2/billing', { signal: context?.signal }),
        );
        let summary: z.infer<typeof usage> | null = null;
        if (!info.credits && !info.freeMonthlyLimits) {
          const data = totals.parse(
            await http.request('get', '/v2/usage/totals-with-completeness', {
              signal: context?.signal,
            }),
          );
          if (data.isComplete)
            summary = data.items.reduce(
              (sum, item) => ({
                totalCostCents:
                  sum.totalCostCents +
                  ('totalGenerationsAmountBilledCents' in item
                    ? item.totalGenerationsAmountBilledCents
                    : item.totalIntegrationsAmountBilledCents),
                totalFrames:
                  sum.totalFrames + ('totalFramesCount' in item ? item.totalFramesCount : 0),
                totalTtsSeconds:
                  sum.totalTtsSeconds +
                  ('totalSecondsGenerated' in item ? item.totalSecondsGenerated : 0),
              }),
              { totalCostCents: 0, totalFrames: 0, totalTtsSeconds: 0 },
            );
        }
        return response.parse({
          ...info,
          canManageBilling:
            info.canManageBilling && ['owner', 'admin'].includes(identity.organization.role),
          credits: info.credits ?? null,
          usage: summary,
        });
      },
    },
    {
      name: 'rename-project',
      title: 'Rename a Sync project',
      description:
        'Change only the name of an accessible Sync project in the connected organization. Does not change visibility, ownership, media, or generations. Requires an explicit user request.',
      inputSchema: rename.shape,
      outputSchema: project.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      handler: async (args, context) => {
        const { projectId, name } = rename.parse(args);
        const result = project.parse(
          await http.request('patch', `/v2/projects/${projectId}`, {
            body: { name },
            signal: context?.signal,
          }),
        );
        if (result.id !== projectId) throw new Error('Could not verify the renamed project.');
        return result;
      },
    },
  ];
}
