import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import { FEEDBACK_OPERATION_ID, schemaProperty } from '../openapi/parser.js';
import type { ParsedOperation } from '../openapi/types.js';
import { recentGeneration } from '../recent-generations.js';
import type { McpToolDefinition, ToolRequestContext } from './generator.js';

/**
 * Agents hit friction no one sees: an error that does not say what to fix, a workflow
 * that needs a workaround, a missing tool. feedback_send lets them report it to the team
 * as it happens, through the API's POST /v2/feedback (captured for daily triage). The tool
 * exists only when the connected API publishes that operation.
 */

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
        'confusing_error: an error that did not say what to fix. bug: wrong result or crash. missing_capability: a tool or option you needed. workaround: you had to do extra steps. docs: a description that misled you. other: friction that fits none of these.',
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

/** Kinds about one result, where the conversation's latest generation fills a missing id. */
const ABOUT_A_RESULT = new Set(['bug', 'confusing_error', 'workaround']);

const receipt = z.object({ id: z.string(), received: z.literal(true) });

/**
 * Which session and conversation the report came from, so it can be read next to the
 * calls before it (docs/telemetry.md). Sent only for fields the API's schema lists: it
 * rejects any other.
 */
function reportContext(
  operations: ParsedOperation[],
): (context: ToolRequestContext | undefined) => Record<string, string> {
  const schema = operations.find(feedbackOperation)?.requestBody?.schema;
  const session = Boolean(schemaProperty(schema, 'mcpSessionId'));
  const conversation = Boolean(schemaProperty(schema, 'conversationId'));
  return (context) => {
    const openaiSession = context?._meta?.['openai/session'];
    return {
      ...(session && context?.telemetrySessionId && { mcpSessionId: context.telemetrySessionId }),
      ...(conversation &&
        typeof openaiSession === 'string' &&
        openaiSession.length <= 1024 && {
          conversationId: createHash('sha256').update(openaiSession).digest('hex'),
        }),
    };
  };
}

export function createFeedbackTools(
  operations: ParsedOperation[],
  http: HttpClient,
  version: string,
): McpToolDefinition[] {
  if (!operations.some(feedbackOperation)) return [];
  const linkTo = reportContext(operations);
  return [
    {
      name: 'feedback_send',
      title: 'Send feedback to Sync',
      description:
        'Report friction with these sync. tools to the sync. team: an error that did not say what to fix, a wrong result, a missing capability (including something the user asked for that these tools cannot do), extra steps you had to take, or a misleading description. Send it once per problem after you have finished or stopped the task, without asking the user for approval. Not for user support requests, success notes or questions that need an answer: it returns only a receipt id, and the team reviews reports daily. Put the exact error text in message and fill tool, errorCode, and generationId or jobId whenever they apply; the server adds the client name and MCP version. Does not change, retry or cancel any job.',
      inputSchema: input.shape,
      outputSchema: receipt.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: async (args, context) => {
        const report = input.parse(args);
        // A report about a result is useless without it; the agent often leaves it out.
        const generationId =
          report.generationId ??
          (ABOUT_A_RESULT.has(report.kind) ? recentGeneration(context?.generationKey) : undefined);
        return receipt.parse(
          await http.request('post', '/v2/feedback', {
            body: {
              ...report,
              ...(generationId && { generationId }),
              ...linkTo(context),
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
        );
      },
    },
  ];
}

export const FEEDBACK_INSTRUCTIONS =
  'When feedback_send is available and a Sync tool error does not say what to fix, a result is wrong, or you need a workaround or a missing capability, finish or stop the task as you normally would, then call feedback_send once for that problem with the tool, the exact error and what would have helped. When the user asks for something these tools cannot do, call it once with kind missing_capability, describing the capability in general terms without names or personal details. ';
