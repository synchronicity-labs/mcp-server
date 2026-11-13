import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpToolDefinition } from './tools/generator.js';

const createCall = z
  .object({
    tool: z.enum(['dubbing_create', 'lipsync_create']),
    arguments: z.record(z.string(), z.unknown()),
  })
  .describe(
    'Optional. The exact create call this quote is for: the tool and its arguments, complete and final, without idempotencyKey. When given, the price card in the chat gets a Create button that starts that paid job itself when the person presses it, and then tells you its generation id. Pass it only for a job the person asked for, once every input is saved and settled. Never call the create tool yourself for the same job after the card reports it started.',
  );

/**
 * Makes a quote self-describing for the price check card: the result repeats what was
 * priced, and carries the create call the card's button runs when the model supplied one,
 * with the idempotency key that call must use.
 */
export function withPriceCheck(tool: McpToolDefinition): McpToolDefinition {
  if (tool.name !== 'generations_estimate-cost' || tool.resultFormat === 'mcp') return tool;
  const { handler } = tool;
  return {
    ...tool,
    inputSchema: { ...tool.inputSchema, create: createCall.optional() },
    handler: async (args, context) => {
      const { create, ...priced } = args;
      const result = await handler(priced, context);
      if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
      const call = createCall.safeParse(create);
      return {
        ...result,
        request: { model: priced.model, duration: priced.duration, workflow: priced.workflow },
        // The key is made with the quote, so a card the host reloads sends the same one
        // and cannot start the video twice.
        ...(call.success ? { create: { ...call.data, idempotencyKey: randomUUID() } } : {}),
      };
    },
  };
}
