import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';

/**
 * Agents hit friction no one sees: an error that does not say what to fix, a workflow
 * that needs a workaround, a missing tool. feedback_send lets them report it to the team
 * as it happens, through the API's POST /v2/feedback (captured for daily triage). The tool
 * exists only when the connected API publishes that operation.
 */
export const FEEDBACK_OPERATION_ID = 'agentFeedback_submit';

export function feedbackOperation(operation: ParsedOperation): boolean {
  return (
    operation.operationId === FEEDBACK_OPERATION_ID &&
    operation.method === 'post' &&
    operation.path === '/v2/feedback'
  );
}

const input = z
  .object({
    kind: z
      .enum(['confusing_error', 'bug', 'missing_capability', 'workaround', 'docs', 'other'])
      .describe(
        'confusing_error: an error that did not say what to fix. bug: wrong result or crash. missing_capability: a tool or option you needed. workaround: you had to do extra steps. docs: a description that misled you.',
      ),
    message: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe(
        'What you tried, what happened, and what would have helped. Include the exact error text. No personal data or secrets.',
      ),
    tool: z.string().trim().min(1).max(128).optional().describe('Tool the feedback is about.'),
    errorCode: z.string().trim().min(1).max(128).optional().describe('Error code you received.'),
    generationId: z.uuid().optional().describe('Generation the feedback is about.'),
    jobId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe('Other job the feedback is about: an import, transcription or translation id.'),
    severity: z
      .enum(['blocker', 'major', 'minor'])
      .optional()
      .describe(
        'blocker: you could not finish. major: you finished with a workaround. minor: an annoyance.',
      ),
  })
  .strict();

const receipt = z.object({ id: z.string(), received: z.literal(true) });

export function createFeedbackTools(
  operations: ParsedOperation[],
  http: HttpClient,
  version: string,
): McpToolDefinition[] {
  if (!operations.some(feedbackOperation)) return [];
  return [
    {
      name: 'feedback_send',
      title: 'Send feedback to Sync',
      description:
        'Tell the Sync team about friction with these tools: an error that did not say what to fix, a result that was wrong, a capability you needed, or extra steps you had to take. Send one report per problem, after you have dealt with it; the team reviews reports daily. Does not change, retry or cancel any job, and never needs the user’s approval.',
      inputSchema: input.shape,
      outputSchema: receipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: async (args, context) =>
        receipt.parse(
          await http.request('post', '/v2/feedback', {
            body: {
              ...input.parse(args),
              source: 'mcp',
              mcpVersion: version,
              client: {
                name: (context?.clientName ?? context?.clientProfile?.name ?? 'unknown').slice(
                  0,
                  128,
                ),
              },
            },
            signal: context?.signal,
          }),
        ),
    },
  ];
}

export const FEEDBACK_INSTRUCTIONS =
  'When feedback_send is available and a Sync tool error does not say what to fix, a result is wrong, or you need a workaround or a missing capability, finish or stop the task as you normally would, then call feedback_send once for that problem with the tool, the exact error and what would have helped. ';
