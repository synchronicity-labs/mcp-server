import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import {
  chosenOrganization,
  type OrganizationSession,
  type OrganizationSummary,
  type RanIn,
  runInOrganization,
} from '../organization-selection.js';
import type { McpToolDefinition, ToolRequestContext } from './generator.js';
import {
  type CredentialKind,
  sessionOf,
  summary,
  defaultOrganization,
  apiKeyBound,
  readAccountAs,
  organizationSummarySchema,
} from './organizations.js';

// Longest a result waits to name its default organization; past it, `organization` is omitted.
const ORGANIZATION_LOOKUP_MS = 2_000;

/** Creates, estimates and billing reads that take a one-call organizationId. */
const PER_CALL_ORGANIZATION_TOOLS = new Set([
  'account_get-usage',
  // A refused create's approval link must pay for the organization that refused it.
  'billing-approval-links_create',
  // Likewise a payment link: paying it must unblock the organization that refused.
  'billing-payment-links_create',
  'lipsync_create',
  'lipsync_create-from-assets',
  'lipsync_create-timeline',
  'dubbing_create',
  'translation-previews_create',
  'translation-previews_estimate',
  'dialogue-previews_create',
  'dialogue-videos_create',
  'dialogue-videos_estimate',
  'generations_create',
  'generations_estimate-cost',
  // From the batch tools (CRAFT-7781); applies once they are registered.
  'batches_create',
]);

const organizationOutput = organizationSummarySchema
  .optional()
  .describe('The Sync organization this call ran in.');

const organizationIdInput = z
  .uuid()
  .optional()
  .describe(
    'Run only this call in another of the user’s Sync organizations, by id from organizations_list, when the user asks for it (for example “generate this in the Acme org”). The session keeps its organization; reads of the ids this call returns stay in this organization. Omit to use the session’s organization.',
  );

// Ids a create returns: its job, generation, project or output asset.
function returnedIds(result: unknown): string[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  return Object.entries(result).flatMap(([key, value]) =>
    (key === 'id' || key.endsWith('Id')) && z.uuid().safeParse(value).success
      ? [value as string]
      : [],
  );
}

async function organizationForCall(
  http: HttpClient,
  credential: CredentialKind,
  session: OrganizationSession,
  organizationId: string,
  signal: AbortSignal | undefined,
): Promise<{ organization: OrganizationSummary; scoped: boolean }> {
  const active = chosenOrganization();
  if (active?.id === organizationId) return { organization: active, scoped: true };
  // Running in the credential's own organization needs no header.
  if (credential === 'api_key' || !active) {
    const own =
      credential === 'api_key'
        ? await defaultOrganization(http, session, signal)
        : await defaultOrganization(http, session, signal).catch(() => undefined);
    if (own?.id === organizationId) return { organization: own, scoped: false };
    if (credential === 'api_key') throw apiKeyBound(own);
  }
  const account = await readAccountAs(http, organizationId, signal);
  return { organization: summary(account.organization), scoped: true };
}

function withOrganization(result: unknown, organization: OrganizationSummary | undefined): unknown {
  if (!organization || !result || typeof result !== 'object' || Array.isArray(result))
    return result;
  return { ...result, organization };
}

/**
 * Adds an optional organizationId that runs one call in another organization,
 * and reports the organization each call ran in.
 */
export function withOrganizationChoice(
  tool: McpToolDefinition,
  http: HttpClient,
  credential: CredentialKind,
): McpToolDefinition {
  if (!PER_CALL_ORGANIZATION_TOOLS.has(tool.name)) return tool;
  const run = async <T>(
    args: Record<string, unknown>,
    context: ToolRequestContext | undefined,
    handler: (fields: Record<string, unknown>) => Promise<T>,
  ): Promise<{ result: T; organization?: OrganizationSummary }> => {
    const { organizationId, ...fields } = args;
    const session = sessionOf();
    // Ids a create returns are read in the organization it ran in, even after a switch.
    // API keys have one organization and never send the header, so they remember nothing.
    // `ranIn` is fixed before the call starts, so it never depends on naming the organization.
    const remember = (ids: string[], ranIn: RanIn) => {
      if (credential === 'user') session.rememberIds(ids, ranIn);
    };
    const execute = async (ranIn: RanIn) => {
      try {
        return await handler(fields);
      } catch (error) {
        // An uncertain admission names its generation; recovery must read the same organization.
        if (error instanceof ApiRequestError && error.generationId)
          remember([error.generationId], ranIn);
        throw error;
      }
    };
    const finish = (result: T, ranIn: RanIn, organization: OrganizationSummary | undefined) => {
      remember(
        returnedIds(
          tool.resultFormat === 'mcp' ? (result as CallToolResult).structuredContent : result,
        ),
        ranIn,
      );
      return { result, organization };
    };
    if (typeof organizationId !== 'string') {
      const active = chosenOrganization();
      // Read alongside the call, bounded, so naming the organization never delays a result.
      const deadline = AbortSignal.timeout(ORGANIZATION_LOOKUP_MS);
      const lookup = active
        ? Promise.resolve(active)
        : defaultOrganization(
            http,
            session,
            context?.signal ? AbortSignal.any([context.signal, deadline]) : deadline,
          ).catch(() => undefined);
      const result = await execute(active ?? null);
      return finish(result, active ?? null, await lookup);
    }
    const { organization, scoped } = await organizationForCall(
      http,
      credential,
      session,
      organizationId,
      context?.signal,
    );
    const ranIn = scoped ? organization : null;
    const result = await runInOrganization(ranIn ?? undefined, () => execute(ranIn));
    return finish(result, ranIn, organization);
  };
  const definition = {
    ...tool,
    inputSchema: { ...tool.inputSchema, organizationId: organizationIdInput },
    ...(tool.outputSchema
      ? { outputSchema: { ...tool.outputSchema, organization: organizationOutput } }
      : {}),
  };
  if (tool.resultFormat === 'mcp')
    return {
      ...definition,
      resultFormat: 'mcp',
      handler: async (args, context) => {
        const { result, organization } = await run(args, context, (fields) =>
          tool.handler(fields, context),
        );
        if (result.isError || !organization) return result;
        return {
          ...result,
          structuredContent: withOrganization(result.structuredContent, organization) as
            | Record<string, unknown>
            | undefined,
        };
      },
    };
  return {
    ...definition,
    resultFormat: 'json',
    handler: async (args, context) => {
      const { result, organization } = await run(args, context, (fields) =>
        tool.handler(fields, context),
      );
      return withOrganization(result, organization);
    },
  };
}
