import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ClientProfile } from './client-profile.js';
import { LIPSYNC_INPUTS_NOT_FROM_ASSETS } from './tools/app-tools.js';
import type { McpToolDefinition } from './tools/generator.js';
import { REASONING_MODELS } from './tools/model-options.js';
import { projectIntentError, projectUseAllowed } from './tools/project-intent.js';

const createCall = z
  .object({
    tool: z.enum(['dubbing_create', 'lipsync_create']),
    arguments: z.record(z.string(), z.unknown()),
  })
  .describe(
    'Optional. The exact create call this quote is for: the tool and its arguments, complete and final, without idempotencyKey or projectCreationKey (the quote makes both) and without organizationId (the call runs in the organization this quote runs in). It must be the job priced here: dubbing_create only with workflow=translate-and-dub, lipsync_create only without it, the same model, and options.reasoning_enabled only with reasoningEnabled=true. When given, the price card in the chat gets a Create button that starts that paid job itself when the person presses it, and then tells you its generation id. Pass it only for a job the person asked for, once every input is saved and settled. Never call the create tool yourself for the same job after the card reports it started.',
  );

/**
 * The create call as the card will run it, or the reason it is not the job this quote
 * prices. The person approves a price, so the call must be for that workflow and model. Its
 * keys are made here, with the quote: a card the host reloads sends the same ones, so a
 * retry can start neither a second video nor a second project.
 */
function quotedCall(
  call: z.infer<typeof createCall>,
  priced: Record<string, unknown>,
  profile: ClientProfile | undefined,
) {
  const dub = priced.workflow === 'translate-and-dub';
  if (dub !== (call.tool === 'dubbing_create'))
    throw new Error(
      `create.tool is ${call.tool} but this quote prices ${dub ? 'a translate-and-dub' : 'a lipsync'}. Quote with workflow=translate-and-dub for dubbing_create, and without it for lipsync_create.`,
    );
  const model = call.arguments.model ?? priced.model;
  if (model !== priced.model)
    throw new Error(
      `create.arguments.model is ${String(model)} but this quote prices ${String(priced.model)}. Quote the model the job will use.`,
    );
  // Reasoning costs more, so a job that turns it on must have been quoted with it.
  const options = z
    .object({ reasoning_enabled: z.boolean().optional() })
    .safeParse(call.arguments.options).data;
  const reasons = options?.reasoning_enabled === true && REASONING_MODELS.has(String(model));
  if (reasons !== (priced.reasoningEnabled === true))
    throw new Error(
      reasons
        ? 'create.arguments.options.reasoning_enabled is true but this quote prices the job without reasoning. Quote with reasoningEnabled=true.'
        : `This quote prices reasoning, but the create call does not use it${REASONING_MODELS.has(String(model)) ? '' : `: ${String(model)} has none`}. Quote without reasoningEnabled, or set create.arguments.options.reasoning_enabled.`,
    );
  // The price is for one organization's plan, balance and assets. The call may not name
  // another: the quote names the organization, and the call is tied to it below.
  const named = call.arguments.organizationId;
  const quoted = typeof priced.organizationId === 'string' ? priced.organizationId : undefined;
  if (named !== undefined && named !== quoted)
    throw new Error(
      `create.arguments.organizationId is ${JSON.stringify(named)} but this quote runs in ${quoted ?? 'the session’s organization'}. Pass organizationId on the quote, and the same one or none in create.arguments.`,
    );
  // The create tools refuse an existing project the person did not choose. The card may
  // run this call through an entry point without that check, so it is made here.
  const { projectIntent, ...fields } = call.arguments;
  if (!projectUseAllowed(fields.projectId, projectIntent))
    throw projectIntentError('The quote was not made: ');
  const tool = cardTool(call, profile);
  if (!tool) return undefined;
  const placed = 'projectId' in fields || 'projectCreationKey' in fields;
  return {
    tool,
    arguments: {
      // The saved-assets entry point has no projectIntent input; the others require it.
      ...(tool === call.tool ? call.arguments : fields),
      model,
      // A new project needs its own key, or a retry would make another project.
      ...(placed ? {} : { projectCreationKey: randomUUID() }),
    },
    idempotencyKey: randomUUID(),
  };
}

/**
 * The tool a card on this client can call for the quoted job, if any. A host with the
 * Sync app refuses a card's call to lipsync_create, which takes attached files there, so
 * its cards start a lipsync through the entry point for saved assets. A lipsync that
 * needs an input that entry point does not take has no call a card can run: the quote
 * then carries none, and the card asks the chat to create it.
 */
function cardTool(call: z.infer<typeof createCall>, profile: ClientProfile | undefined) {
  if (call.tool !== 'lipsync_create' || !profile?.supportsAppUi) return call.tool;
  return LIPSYNC_INPUTS_NOT_FROM_ASSETS.some((key) => call.arguments[key] !== undefined)
    ? undefined
    : 'lipsync_create-from-assets';
}

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
      const call =
        create === undefined
          ? undefined
          : quotedCall(createCall.parse(create), priced, context?.clientProfile);
      const result = await handler(priced, context);
      if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
      // The organization the quote ran in, so the card's call runs there too: neither a
      // one-call organizationId on the quote nor a later switch of the session moves it.
      const ranIn =
        z.object({ organization: z.object({ id: z.uuid() }) }).safeParse(result).data?.organization
          .id ?? priced.organizationId;
      return {
        ...result,
        request: { model: priced.model, duration: priced.duration, workflow: priced.workflow },
        ...(call
          ? {
              create: {
                ...call,
                arguments: {
                  ...call.arguments,
                  ...(typeof ranIn === 'string' ? { organizationId: ranIn } : {}),
                },
              },
            }
          : {}),
      };
    },
  };
}
