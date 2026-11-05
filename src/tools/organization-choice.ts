import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ApiRequestError, type HttpClient } from '../http-client.js';
import {
  chosenOrganization,
  type OrganizationSession,
  type OrganizationSummary,
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

/** Paid creates, and the estimates that quote them, that take a one-call organizationId. */
const PER_CALL_ORGANIZATION_TOOLS = new Set([
  'create-lipsync',
  'create-lipsync-from-assets',
  'create-timeline-lipsync',
  'create-translate-and-dub',
  'create-translation-preview',
  'estimate-translation-preview',
  'create-dialogue-preview',
  'create-dialogue-video',
  'estimate-dialogue-video',
  'generate_create-generation',
  'generate_estimate-cost',
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
 * Adds an optional organizationId that runs one paid create in another organization,
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
    const remember = (ids: string[], organization: OrganizationSummary | undefined) => {
      if (credential === 'user' && organization) session.rememberIds(ids, organization);
    };
    const execute = async (organization: Promise<OrganizationSummary | undefined>) => {
      try {
        return await handler(fields);
      } catch (error) {
        // An uncertain admission names its generation; recovery must read the same organization.
        if (error instanceof ApiRequestError && error.generationId)
          remember([error.generationId], await organization);
        throw error;
      }
    };
    const finish = async (result: T, organization: OrganizationSummary | undefined) => {
      remember(
        returnedIds(
          tool.resultFormat === 'mcp' ? (result as CallToolResult).structuredContent : result,
        ),
        organization,
      );
      return { result, organization };
    };
    if (typeof organizationId !== 'string') {
      const active = chosenOrganization();
      // Read alongside the call, so reporting the organization adds no latency.
      const lookup = active
        ? Promise.resolve(active)
        : defaultOrganization(http, session, context?.signal).catch(() => undefined);
      const result = await execute(lookup);
      return finish(result, await lookup);
    }
    const { organization, scoped } = await organizationForCall(
      http,
      credential,
      session,
      organizationId,
      context?.signal,
    );
    const known = Promise.resolve(organization);
    const result = scoped
      ? await runInOrganization(organization, () => execute(known))
      : await runInOrganization(undefined, () => execute(known));
    return finish(result, organization);
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
