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
  hasActiveCredits: z.boolean().optional(),
  freeGenerationsExhausted: z.boolean().optional(),
  freeTtsExhausted: z.boolean().optional(),
  elevenLabsKeyConnected: z.boolean().optional(),
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
const rename = z.object({
  projectId: z
    .uuid()
    .describe(
      'Project to rename (UUID), from projects_list, or from projects_create for the project just made for this request.',
    ),
  name: z.string().trim().min(1).max(255).describe('New project name, up to 255 characters.'),
  projectIntent: z
    .literal('explicit')
    .optional()
    .describe(
      'Set to explicit whenever you pass projectId: the user asked to rename this project, selected it in the interface, or it is the project just created for this request. Never infer it from a matching project name, workflow name or open editor.',
    ),
});
const project = z.object({ id: z.uuid(), name: z.string() });

export function createAccountManagementTools(http: HttpClient): McpToolDefinition[] {
  return [
    {
      name: 'account_get-usage',
      title: 'Read Sync usage and balance',
      description:
        "Read what the connected sync. organization has left to spend in the current billing period. Use this before lipsync to check free coverage; an estimate's base price is not a charge when the request is fully covered. credits gives balance, available (spendable now) and inFlight (held by running jobs); freeMonthlyLimits gives generations and text-to-speech used and max, with monthlyResetDate. A script needs both allowances. elevenLabsKeyConnected=true means speech may incur external provider charges. Missing hasActiveCredits, exhaustion or provider-key fields mean unknown coverage, never false. Only when credits and freeMonthlyLimits are both null does it fill usage with the period's billed totalCostCents, totalFrames and totalTtsSeconds, and usage stays null if the API reports those totals as incomplete. canManageBilling is true only when billing allows it and the caller is an owner or admin. Not for what one past generation cost (generations_get-costs, when available), a quote for paid work (generations_estimate-cost), or plan limits and organization (account_get-context). Buys no credits, changes no plan and starts no generation.",
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
      name: 'projects_rename',
      title: 'Rename a Sync project',
      description:
        "Rename one existing project you can access in the current organization; only the name changes, while visibility, owner, media and generations stay as they are. Use it only when the user explicitly asks to rename that project, never because its name or workflow matches the request or its editor is open; new work gets a new project from projects_create instead. Always pass projectIntent=explicit, including for a project you just created for this request; a rename without it can be refused with PROJECT_INTENT_REQUIRED. A missing, deleted or inaccessible project returns a 404 error. Returns the project's id and new name.",
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
        if (result.id.toLowerCase() !== projectId.toLowerCase())
          throw new Error('Could not verify the renamed project.');
        return result;
      },
    },
  ];
}
