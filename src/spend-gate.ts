import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { HttpClient } from './http-client.js';
import {
  type OrganizationSession,
  type OrganizationSummary,
  runInOrganization,
  runInOrganizationSession,
} from './organization-selection.js';

/**
 * The server asks the person, not just the model, before paid work and before switching the
 * organization that work is billed to. The question goes to the client as an MCP elicitation,
 * so text the model reads (a transcript, an asset name) cannot answer it. It applies only where
 * the client declared elicitation on a connection that can carry it (stdio today), and only
 * while spend confirmation is on: an operator's unattended mode turns it off with the rest.
 */

/** Tools that start work the organization can be charged for. */
export const PAID_TOOLS: Readonly<Record<string, (args: Record<string, unknown>) => string>> = {
  lipsync_create: () => 'a lipsync generation',
  'lipsync_create-from-assets': () => 'a lipsync generation',
  'lipsync_create-timeline': () => 'a timeline lipsync generation',
  shots_regenerate: (args) => `rendering ${count(args.shots, 'shot')} again`,
  dubbing_create: () => 'a translation and dub',
  'translation-previews_create': () => 'a translated audio preview',
  'dialogue-previews_create': () => 'a dialogue edit preview',
  'dialogue-videos_create': () => 'a dialogue edit video',
  'speech-previews_create': () => 'a speech preview',
  'jobs_create-many': (args) =>
    `${count(args.items, 'job')}${typeof args.tool === 'string' ? ` with ${args.tool}` : ''}`,
  batches_create: (args) => `a batch of ${count(args.items, 'generation')}`,
  voices_clone: () => 'a voice clone',
  generations_create: () => 'a generation',
  tts_create: () => 'speech synthesis',
  'tts-jobs_create': () => 'speech synthesis',
  'dialogue-edits_create': () => 'a dialogue edit',
};

export const ORGANIZATION_SWITCH_TOOL = 'organizations_select';
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

function count(value: unknown, noun: string): string {
  const n = Array.isArray(value) ? value.length : undefined;
  return n === undefined ? `${noun}s` : `${n} ${noun}${n === 1 ? '' : 's'}`;
}

type ElicitParams = {
  mode?: 'form';
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<
      string,
      { type: 'boolean'; title: string; description: string; default: boolean }
    >;
    required: string[];
  };
};
type ElicitResult = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
export type AskUser = (params: ElicitParams) => Promise<ElicitResult>;

// The free-tier answer has no credits block at all (sync-api-v2 billing.controller.ts says it
// is intentionally absent); purchased credits come with one. So a missing block is the free
// tier, while a missing plan, hasActiveCredits or provider-key field is unknown.
const billing = z.object({
  plan: z.string().nullable(),
  hasActiveCredits: z.boolean().optional(),
  elevenLabsKeyConnected: z.boolean().optional(),
  credits: z.object({ balance: z.number() }).nullish(),
});

/**
 * Whether work in this organization can cost anything. With no plan, no credits and no
 * provider key of its own, an organization is never charged: the API runs work its free
 * allowance covers and refuses the rest (402). Anything else, or an answer missing a field
 * or not arriving, counts as chargeable, so the person is asked.
 */
export function canBeCharged(account: unknown): boolean {
  const parsed = billing.safeParse(account);
  if (!parsed.success) return true;
  const { plan, hasActiveCredits, elevenLabsKeyConnected, credits } = parsed.data;
  return (
    plan !== null ||
    hasActiveCredits !== false ||
    elevenLabsKeyConnected !== false ||
    (credits?.balance ?? 0) > 0
  );
}

function refusalOf(code: string, message: string): GateDecision {
  const structuredContent = {
    error: {
      message,
      code,
      nextStep: 'Nothing was started or charged. Do not call it again unless the user asks you to.',
    },
  };
  return {
    refusal: {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: true,
    },
  };
}

function approvalForm(message: string, title: string): ElicitParams {
  return {
    mode: 'form',
    message,
    requestedSchema: {
      type: 'object',
      properties: {
        approve: {
          type: 'boolean',
          title,
          description: 'Leave this off, or decline, to stop without starting anything.',
          default: false,
        },
      },
      required: ['approve'],
    },
  };
}

async function approved(ask: AskUser, form: ElicitParams): Promise<boolean | Error> {
  try {
    const answer = await ask(form);
    return answer.action === 'accept' && answer.content?.approve === true;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function label(organization: OrganizationSummary | undefined): string {
  if (!organization) return 'your default sync. organization';
  return organization.name
    ? `the sync. organization "${organization.name}"`
    : `the sync. organization ${organization.id}`;
}

/** Refuse with `refusal`, or run the call inside `within`; undefined runs it as it is. */
export type GateDecision = { refusal: CallToolResult } | { within: <T>(run: () => T) => T };
export type SpendGate = (
  tool: string,
  args: Record<string, unknown>,
  ask: AskUser,
  signal?: AbortSignal,
) => Promise<GateDecision | undefined>;

// The organization the session had selected when a paid call was checked (and approved). A
// switch that lands while the person is being asked must not move the approved work. Only
// organizations_select changes the selection; learning the credential's default does not.
const checkedIn = new AsyncLocalStorage<{ selectedId: string | undefined }>();

export class OrganizationChangedError extends Error {
  constructor() {
    super(
      'The sync. organization changed while this paid action was being checked or approved. Nothing was started; call it again to be asked about the organization now in use.',
    );
  }
}

/** Throws when the session switched organization since this call's spending check. */
export function assertCheckedOrganization(session: OrganizationSession): void {
  const checked = checkedIn.getStore();
  if (checked && checked.selectedId !== session.selected?.id) throw new OrganizationChangedError();
}

/** Undefined lets the call run; a result refuses it with nothing started. */
export function createSpendGate({
  http,
  session,
}: {
  http: HttpClient;
  session: OrganizationSession;
}): SpendGate {
  const organizationsOf = (tool: string, args: Record<string, unknown>) => {
    const selected = session.selected;
    const pinned = (value: unknown): OrganizationSummary | undefined =>
      typeof value === 'string' && value ? { id: value, name: null } : selected;
    // A job set runs where its items say; the call's own organization only fills the gaps.
    const items =
      tool === 'jobs_create-many' && Array.isArray(args.items) && args.items.length > 0
        ? (args.items as Array<Record<string, unknown> | null>)
        : undefined;
    const organizations = items
      ? items.map((item) => pinned(item?.organizationId ?? args.organizationId))
      : [pinned(args.organizationId)];
    const unique = new Map(organizations.map((organization) => [organization?.id, organization]));
    return [...unique.values()];
  };

  const chargeable = async (
    organization: OrganizationSummary | undefined,
    signal: AbortSignal | undefined,
  ) => {
    try {
      const account = await runInOrganizationSession(session, () =>
        runInOrganization(organization, () => http.request('get', '/v2/billing', { signal })),
      );
      return canBeCharged(account);
    } catch (error) {
      // A cancelled call stops here; any other failed read means unknown, so ask.
      if (signal?.aborted) throw error;
      return true;
    }
  };

  return async (tool, args, ask, signal) => {
    if (tool === ORGANIZATION_SWITCH_TOOL) {
      const target = typeof args.organizationId === 'string' ? args.organizationId : undefined;
      if (!target || target === session.activeOrganizationId()) return undefined;
      const answer = await approved(
        ask,
        approvalForm(
          `Switch this connection to the sync. organization ${target}? Paid work after the switch is billed to that organization.`,
          'Switch organization',
        ),
      );
      if (answer === true) return undefined;
      return refusalOf(
        answer instanceof Error ? 'APPROVAL_UNAVAILABLE' : 'ORGANIZATION_SWITCH_NOT_APPROVED',
        answer instanceof Error
          ? `Could not ask the user to approve switching organization: ${answer.message}`
          : 'The user did not approve switching the sync. organization.',
      );
    }

    const describe = PAID_TOOLS[tool];
    if (!describe || (tool === 'batches_create' && args.dryRun === true)) return undefined;
    const sessionOrganization = { selectedId: session.selected?.id };
    const within = <T>(run: () => T) => checkedIn.run(sessionOrganization, run);
    const organizations = organizationsOf(tool, args);
    const charged = (
      await Promise.all(organizations.map((organization) => chargeable(organization, signal)))
    ).some(Boolean);
    if (!charged) return { within };
    const where = organizations.map(label).join(', ');
    const answer = await approved(
      ask,
      approvalForm(
        `Start ${describe(args)} in ${where}? This can use the organization's plan, credits or connected provider and be charged.`,
        'Approve this paid action',
      ),
    );
    if (answer === true) return { within };
    return refusalOf(
      answer instanceof Error ? 'APPROVAL_UNAVAILABLE' : 'SPEND_NOT_APPROVED',
      answer instanceof Error
        ? `Could not ask the user to approve this paid action: ${answer.message}`
        : 'The user did not approve this paid action.',
    );
  };
}

/**
 * The gate for this server, or none. Hosted requests each get a fresh server that cannot ask
 * the client anything mid-call, and unattended mode has the operator's approval already.
 */
export function spendGateFor(
  config: { transport: 'stdio' | 'http'; spendConfirmation?: boolean },
  { canAsk, ...dependencies }: Parameters<typeof createSpendGate>[0] & { canAsk: () => boolean },
): SpendGate | undefined {
  // Unset means on, as everywhere else spend confirmation is read.
  if (config.transport !== 'stdio' || config.spendConfirmation === false) return undefined;
  const gate = createSpendGate(dependencies);
  return async (tool, args, ask, signal) => (canAsk() ? gate(tool, args, ask, signal) : undefined);
}
