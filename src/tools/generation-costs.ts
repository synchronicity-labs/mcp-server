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
      .describe('Existing Sync generation ID returned by generation creation or history tools.'),
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
      name: 'get-generation-costs',
      title: 'View actual generation costs',
      description:
        'Read recorded costs for a past Sync generation, with dubbing and lip sync listed separately. Use for what a generation actually cost, not a preflight estimate. Credit amounts express credit face value, not a card payment. Pending or unavailable components have no known total. Does not generate media or change billing.',
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
