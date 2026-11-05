import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request organization choice for session and OAuth credentials (sync-api-v2,
 * CRAFT-7789). API keys are bound to their organization and never send it.
 */
export const ORGANIZATION_HEADER = 'x-sync-organization-id';

export type OrganizationSummary = { id: string; name: string | null };

/** Where a call ran: a named organization, or null for the credential's own, sent without a header. */
export type RanIn = OrganizationSummary | null;

// Ids a call in another organization returned, so its follow-up reads stay there.
const REMEMBERED_IDS_LIMIT = 500;
const DEFAULT_ORGANIZATION_TTL_MS = 60_000;

/**
 * One MCP session's organization: the stdio process, or one hosted session. Nothing here
 * grants access; the API checks membership on every request that names an organization.
 */
export class OrganizationSession {
  /** Chosen with organizations_select; every later call in this session sends it. */
  selected?: OrganizationSummary;
  /** Feature flags of the active organization from GET /v2/account, when it reports them. */
  features?: string[];
  #default?: { organization: OrganizationSummary; expiresAt: number };
  // Kept after the cache expires: tells the credential's own organization from others.
  #defaultId?: string;
  readonly #organizationById = new Map<string, RanIn>();

  /** The credential's own organization, as last read without a selection. */
  defaultOrganization(): OrganizationSummary | undefined {
    return this.#default && this.#default.expiresAt > Date.now()
      ? this.#default.organization
      : undefined;
  }

  rememberDefault(organization: OrganizationSummary): void {
    this.#default = { organization, expiresAt: Date.now() + DEFAULT_ORGANIZATION_TTL_MS };
    this.#defaultId = organization.id;
  }

  /** Whether calls in this session now run where `organization` is. */
  isCurrent(organization: RanIn): boolean {
    if (organization === null) return this.selected === undefined;
    return this.selected
      ? this.selected.id === organization.id
      : this.#defaultId === organization.id;
  }

  /** The credential's own organization id, if it was ever read. */
  defaultId(): string | undefined {
    return this.#defaultId;
  }

  /** Records ids returned by a call that ran in `organization`. */
  rememberIds(ids: string[], organization: RanIn): void {
    for (const id of ids) {
      this.#organizationById.delete(id);
      this.#organizationById.set(id, organization);
    }
    while (this.#organizationById.size > REMEMBERED_IDS_LIMIT) {
      const oldest = this.#organizationById.keys().next().value;
      if (oldest === undefined) break;
      this.#organizationById.delete(oldest);
    }
  }

  /** Where a remembered id in these arguments was created; undefined when none is. */
  organizationFor(args: Record<string, unknown>): RanIn | undefined {
    if (this.#organizationById.size === 0) return undefined;
    for (const value of Object.values(args)) {
      if (typeof value === 'string' && this.#organizationById.has(value))
        return this.#organizationById.get(value);
    }
    return undefined;
  }
}

const sessionStore = new AsyncLocalStorage<OrganizationSession>();
// A call's organization, fixed when it starts; undefined pins the credential's default.
const callStore = new AsyncLocalStorage<{ organization?: OrganizationSummary }>();

export function runInOrganizationSession<T>(session: OrganizationSession, fn: () => T): T {
  return sessionStore.run(session, fn);
}

export function currentOrganizationSession(): OrganizationSession | undefined {
  return sessionStore.getStore();
}

/**
 * Runs `fn` in `organization`, or in the credential's default when undefined, whatever the
 * session selects meanwhile. The session's selection is not changed.
 */
export function runInOrganization<T>(
  organization: OrganizationSummary | undefined,
  fn: () => T,
): T {
  return callStore.run({ organization }, fn);
}

/** The organization this call runs in when one was chosen: the call's pin, else the session. */
export function chosenOrganization(): OrganizationSummary | undefined {
  const pinned = callStore.getStore();
  return pinned ? pinned.organization : sessionStore.getStore()?.selected;
}
