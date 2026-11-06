import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';

const money = z.string().regex(/^\d+\.\d{5}$/);
const component = z.object({
  type: z.enum(['lipsync', 'dubbing', 'speech_synthesis']),
  operationId: z.uuid().nullable(),
  status: z.enum(['recorded', 'pending', 'unavailable', 'not_charged']),
  amountUsd: money.nullable(),
  credits: z.string().regex(/^\d+$/).nullable(),
  valueBasis: z.enum(['credit_face_value', 'metered_usage', 'none']).nullable(),
  quantity: z.number().nonnegative().nullable(),
  unit: z.enum(['frames', 'seconds']),
  unitRateUsd: money.nullable(),
  source: z.enum(['credit_ledger', 'recorded_usage', 'billing_context']).nullable(),
  reason: z.string().nullable(),
});
const receipt = z.object({
  generationId: z.uuid(),
  generationStatus: z.string(),
  currency: z.literal('USD'),
  availability: z.enum(['complete', 'pending', 'partial', 'unavailable']),
  totalCostUsd: money.nullable(),
  knownSubtotalUsd: money,
  retryAfterSeconds: z.number().int().positive().nullable(),
  components: z.array(component),
  excludedCosts: z.array(z.string()),
});
const input = z
  .object({
    generationId: z
      .uuid()
      .describe(
        'Id of the past generation, as returned by the create tool, generations_list or projects_list-generations.',
      ),
  })
  .strict();

export function generationCostsOperation(operation: ParsedOperation): boolean {
  return (
    operation.operationId === 'GenerateController_getGenerationCosts' &&
    operation.method === 'get' &&
    operation.path === '/v2/generate/{id}/costs'
  );
}

export function createGenerationCostsTools(
  operations: ParsedOperation[],
  http: HttpClient,
): McpToolDefinition[] {
  if (!operations.some(generationCostsOperation)) return [];
  return [
    {
      name: 'generations_get-costs',
      title: 'View actual generation costs',
      description:
        'Read the recorded cost of one past sync. generation in the current organization, split into lipsync, dubbing and speech_synthesis components. Use it to answer what a generation actually cost; not for a price before generating (generations_estimate-cost) or remaining credits (account_get-usage), and never substitute an estimate or start a paid generation to answer a past-cost question. If the user does not know the generationId, find it with generations_list or projects_list-generations and ask which one when several match. totalCostUsd is null unless availability is complete; then present knownSubtotalUsd only as a partial amount. Whenever retryAfterSeconds is set, read again after that many seconds. Report each component separately, give credit amounts as credit face value rather than cash paid, and tell the user that the excludedCosts (tax, subscription fees, external provider charges, account-level adjustments) are not counted. An unknown or inaccessible id returns an error.',
      inputSchema: input.shape,
      outputSchema: receipt.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true },
      handler: async (args, context) => {
        const { generationId } = input.parse(args);
        const result = receipt.parse(
          await http.request('get', `/v2/generate/${generationId}/costs`, {
            signal: context?.signal,
          }),
        );
        if (result.generationId.toLowerCase() !== generationId.toLowerCase())
          throw new Error('Sync returned costs for a different generation.');
        return result;
      },
    },
  ];
}
