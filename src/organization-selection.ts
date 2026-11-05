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

/** Taken before an account read starts; recordFeatures refuses its answer after a switch. */
export type FeatureStamp = Readonly<{ generation: number }>;

/**
 * One MCP session's organization: the stdio process, or one hosted session. Nothing here
 * grants access; the API checks membership on every request that names an organization.
 */
export class OrganizationSession {
  #selected?: OrganizationSummary;
  // Bumped by every select(), so an account read that began before a switch can't write after it.
  #generation = 0;
  // Feature flags from GET /v2/account, stamped with the organization and selection they belong to.
  #features?: { organizationId?: string; generation: number; names: readonly string[] };
  #default?: { organization: OrganizationSummary; expiresAt: number };
  // Kept after the cache expires: tells the credential's own organization from others.
  #defaultId?: string;
  readonly #organizationById = new Map<string, RanIn>();

  /** Chosen with organizations_select; every later call in this session sends it. */
  get selected(): OrganizationSummary | undefined {
    return this.#selected;
  }

  /** Switches the session, with the features read for `organization` (undefined: unknown). */
  select(organization: OrganizationSummary, features: readonly string[] | undefined): void {
    this.#selected = organization;
    this.#generation += 1;
    this.#features = features
      ? { organizationId: organization.id, generation: this.#generation, names: [...features] }
      : undefined;
  }

  featureStamp(): FeatureStamp {
    return { generation: this.#generation };
  }

  /** The organization calls in this session run in, when known: the selection, else the default. */
  activeOrganizationId(): string | undefined {
    return this.#selected?.id ?? this.#defaultId;
  }

  /**
   * Keeps features GET /v2/account answered for `organizationId`, unless the session switched
   * since `stamp` was taken or the answer is for another organization than the active one.
   * Undefined features clear what was kept. Returns whether the write was kept.
   */
  recordFeatures(
    features: readonly string[] | undefined,
    stamp: FeatureStamp,
    organizationId: string | undefined,
  ): boolean {
    if (stamp.generation !== this.#generation) return false;
    const active = this.activeOrganizationId();
    if (organizationId && active && organizationId !== active) return false;
    this.#features = features
      ? {
          organizationId: organizationId ?? active,
          generation: this.#generation,
          names: [...features],
        }
      : undefined;
    return true;
  }

  /**
   * The active organization's features, when they were read for it in the current selection;
   * undefined means unknown, so read them again.
   */
  activeFeatures(): readonly string[] | undefined {
    const kept = this.#features;
    if (!kept || kept.generation !== this.#generation) return undefined;
    const active = this.activeOrganizationId();
    if (kept.organizationId && active && kept.organizationId !== active) return undefined;
    return kept.names;
  }

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
    // Compare by id where one is known: selecting the default organization is no switch.
    const current = this.selected?.id ?? this.#defaultId;
    if (organization === null)
      return this.selected === undefined || this.selected.id === this.#defaultId;
    return current === organization.id;
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
