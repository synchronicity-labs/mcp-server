import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { getAuthOwner, getAuthToken } from '../auth/async-context.js';
import { resolveClientProfile } from '../client-profile.js';
import { REVISION } from '../revision.js';
import { PACKAGE_VERSION } from '../version.js';
import { argumentFacets, invalidFields, type OutcomeFacets, resultFacets } from './facets.js';
import type { TelemetryQueue } from './queue.js';

const CLIENT_NAME = /^[a-z0-9][a-z0-9 ._()/@-]{0,63}$/;
const CLIENT_VERSION = /^[0-9A-Za-z.+_-]{1,32}$/;
const PROTOCOL = /^\d{4}-\d{2}-\d{2}$/;
const REVISION_FORMAT = /^[0-9a-f]{7,40}$/;
const CAPABILITIES = ['sampling', 'elicitation', 'roots', 'tasks'] as const;
const STDIO_OWNER = 'stdio';
// The API refuses a whole batch over any out-of-range number, so cap them here.
const MAX_GAP_MS = 7 * 24 * 3_600_000;
const MAX_LATENCY_MS = 3_600_000;
const MAX_COUNT = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const capped = (value: number, max: number) => Math.min(Math.max(0, Math.round(value)), max);

export function telemetryClientName(name: string | undefined): string | undefined {
  const normalized = name?.trim().toLowerCase();
  if (!normalized) return undefined;
  return CLIENT_NAME.test(normalized) ? normalized : 'other';
}

function clientCapabilities(capabilities: unknown): string[] {
  if (!capabilities || typeof capabilities !== 'object') return [];
  const declared = capabilities as Record<string, unknown>;
  const names: string[] = CAPABILITIES.filter((name) => declared[name] !== undefined);
  // MCP Apps hosts declare the UI extension; its exact home has moved between drafts.
  if (/io\.modelcontextprotocol\/ui/.test(JSON.stringify(capabilities))) names.push('ui');
  return names;
}

/** Where a tool call came from and the ChatGPT context it carries, never its content. */
export type CallContext = {
  tool: string;
  calledAs?: string;
  shape: Record<string, z.ZodType>;
  args: Record<string, unknown> | undefined;
  meta: Record<string, unknown> | undefined;
  invocation: 'model' | 'ui' | 'background';
};

const parentCall = new AsyncLocalStorage<string>();

/** What a call is about, such as a generation or Studio mount, for repeat checks only. */
function targetIds(args: Record<string, unknown> | undefined): string[] {
  return Object.entries(args ?? {})
    .filter(([, value]) => typeof value === 'string' && UUID.test(value))
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort();
}

/** SHA-256 of the call's openai/session, which ChatGPT and Codex send per conversation. */
function conversationId(meta: Record<string, unknown> | undefined): string | undefined {
  const session = meta?.['openai/session'];
  if (typeof session !== 'string' || session.length > 1024) return undefined;
  return createHash('sha256').update(session).digest('hex');
}

function chatgptContext(meta: Record<string, unknown> | undefined): Record<string, string> {
  if (!meta) return {};
  const conversation = conversationId(meta);
  const locale = meta['openai/locale'];
  const location = meta['openai/userLocation'];
  const country =
    location && typeof location === 'object'
      ? (location as Record<string, unknown>).country
      : undefined;
  return {
    ...(conversation && { conversation_id: conversation }),
    ...(typeof locale === 'string' &&
      /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/i.test(locale) && { locale }),
    ...(typeof country === 'string' &&
      /^[A-Za-z]{2}$/.test(country) && { country: country.toUpperCase() }),
  };
}

/**
 * One MCP session's events and call order. Hosted sessions build a new SDK server per
 * request, so this lives with the session, not the server. ChatGPT and Codex open a new
 * session for nearly every call, so their calls are ordered by conversation instead, and
 * the widget's own repeated calls and reconnections are recorded once per window.
 */
export class TelemetrySession {
  readonly id = randomUUID();
  readonly #started = performance.now();
  #client: Record<string, string> = {};
  #callIndex = 0;
  #previousTool: string | undefined;
  #previousCallAt: number | undefined;

  constructor(
    private readonly queue: TelemetryQueue,
    private readonly transport: 'http' | 'stdio',
    private readonly now = () => new Date(),
  ) {}

  setClient(name: string | undefined, version: unknown): void {
    const client = telemetryClientName(name);
    this.#client = {
      client_profile: resolveClientProfile(name).name,
      ...(client && { client_name: client }),
      ...(typeof version === 'string' &&
        CLIENT_VERSION.test(version) && { client_version: version }),
    };
  }

  /** The verified owner and token of the current request, or the stdio process. */
  #owner(owner?: string, token?: string): [string, string | undefined] {
    if (this.transport === 'stdio') return [STDIO_OWNER, undefined];
    return [owner ?? getAuthOwner() ?? 'unknown', token ?? getAuthToken()];
  }

  #record(
    event: 'mcp_session_initialized' | 'mcp_tool_called',
    properties: Record<string, unknown>,
    owner?: string,
    token?: string,
    repeatKey?: string,
  ): void {
    try {
      const [key, credential] = this.#owner(owner, token);
      if (this.transport === 'http' && !credential) return;
      // Nothing is recorded while waiting for the API, so nothing counts as seen either.
      if (!this.queue.active) return;
      if (repeatKey && !this.queue.memory.firstInWindow(JSON.stringify([key, repeatKey]))) return;
      this.queue.record(key, credential, {
        event,
        event_id: randomUUID(),
        timestamp: this.now().toISOString(),
        properties: {
          session_id: this.id,
          transport: this.transport,
          ...this.#client,
          server_version: PACKAGE_VERSION,
          server_revision: REVISION_FORMAT.test(REVISION) ? REVISION : 'unknown',
          ...properties,
        },
      });
    } catch {
      // Telemetry never affects a call.
    }
  }

  initialized(
    details: {
      protocolVersion?: unknown;
      capabilities?: unknown;
      toolsets?: readonly string[];
      spendConfirmation?: boolean;
    },
    owner?: string,
    token?: string,
  ): void {
    const properties = {
      ...(typeof details.protocolVersion === 'string' &&
        PROTOCOL.test(details.protocolVersion) && { protocol_version: details.protocolVersion }),
      client_capabilities: clientCapabilities(details.capabilities),
      ...(details.toolsets && { toolsets: details.toolsets.slice(0, 20) }),
      ...(details.spendConfirmation === false && { spend_confirmation: false }),
    };
    // A hosted client that reconnects for every call is one connection per window.
    const repeatKey =
      this.transport === 'http'
        ? JSON.stringify(['mcp_session_initialized', this.#client, properties])
        : undefined;
    this.#record('mcp_session_initialized', properties, owner, token, repeatKey);
  }

  /** Records a call that the SDK rejected before any handler ran. */
  rejected(context: CallContext): void {
    const sequence = this.#sequence(context);
    this.#record('mcp_tool_called', {
      call_id: randomUUID(),
      ...this.#describe(context, sequence),
      outcome: 'invalid_arguments',
      invalid_fields: invalidFields(context.shape, context.args),
      latency_ms: 0,
    });
  }

  /** Runs a call and records it when it ends. Nested calls name their parent. */
  async track<T>(
    context: CallContext,
    run: () => Promise<T>,
    classify: (error: unknown, result: T | undefined) => OutcomeFacets,
  ): Promise<T> {
    const callId = randomUUID();
    const parent = parentCall.getStore();
    // Calls jobs_create-many makes for the agent are not steps of the agent's own sequence.
    const sequence = parent ? {} : this.#sequence(context);
    const started = performance.now();
    let result: T | undefined;
    let failure: unknown;
    try {
      result = await parentCall.run(callId, run);
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        const outcome = classify(failure, result);
        const facets = failure === undefined ? resultFacets(context.tool, result) : {};
        this.#record(
          'mcp_tool_called',
          {
            call_id: callId,
            ...this.#describe(context, sequence),
            ...(parent && { parent_call_id: parent, invocation: 'nested' }),
            ...outcome,
            ...(outcome.outcome === 'invalid_arguments' && {
              invalid_fields: invalidFields(context.shape, context.args),
            }),
            latency_ms: capped(performance.now() - started, MAX_LATENCY_MS),
            ...facets,
          },
          undefined,
          undefined,
          // The widget repeats its own calls every few seconds; the first of each kind is enough.
          !parent && context.invocation === 'background'
            ? JSON.stringify([
                context.tool,
                outcome.outcome,
                outcome.error_code,
                facets.result_status,
                facets.generation_id ?? facets.job_id,
                targetIds(context.args),
              ])
            : undefined,
        );
      } catch {
        // Telemetry never affects a call.
      }
    }
  }

  /**
   * The call's place in its conversation when it carries one and is not the widget's own
   * background call; otherwise its place in this session.
   */
  #sequence(context: CallContext): Record<string, unknown> {
    const at = performance.now();
    const started = { ms_since_session_start: capped(at - this.#started, MAX_GAP_MS) };
    const conversation = conversationId(context.meta);
    if (this.transport === 'http' && conversation && context.invocation !== 'background') {
      const [owner] = this.#owner();
      const step = this.queue.memory.nextInConversation(
        JSON.stringify([owner, conversation]),
        context.tool,
      );
      return {
        call_index: capped(step.call_index, MAX_COUNT),
        ...(step.previous_tool && { previous_tool: step.previous_tool }),
        ...started,
        ...(step.ms_since_previous_call !== undefined && {
          ms_since_previous_call: capped(step.ms_since_previous_call, MAX_GAP_MS),
        }),
      };
    }
    const tool = context.tool;
    this.#callIndex += 1;
    const sequence = {
      call_index: capped(this.#callIndex, MAX_COUNT),
      ...(this.#previousTool && { previous_tool: this.#previousTool }),
      ...started,
      ...(this.#previousCallAt !== undefined && {
        ms_since_previous_call: capped(at - this.#previousCallAt, MAX_GAP_MS),
      }),
    };
    this.#previousTool = tool;
    this.#previousCallAt = at;
    return sequence;
  }

  #describe(context: CallContext, sequence: Record<string, unknown>): Record<string, unknown> {
    return {
      tool_name: context.tool,
      ...(context.calledAs && context.calledAs !== context.tool && { called_as: context.calledAs }),
      ...sequence,
      invocation: context.invocation,
      args: argumentFacets(context.shape, context.args),
      ...chatgptContext(context.meta),
    };
  }
}
