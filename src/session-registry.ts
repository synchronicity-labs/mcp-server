import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export type SessionOwner = Readonly<{
  sub: string;
  clientId: string;
  organizationId: string | null;
}>;

// Only verified userinfo claims participate; token rotation does not change ownership.
export function sessionOwner(auth: AuthInfo | undefined): SessionOwner | undefined {
  const sub = auth?.extra?.sub;
  const clientId = auth?.clientId;
  const organizationId = auth?.extra?.organizationId;
  const nonempty = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;
  if (
    !nonempty(sub) ||
    !nonempty(clientId) ||
    (organizationId !== undefined && !nonempty(organizationId))
  )
    return undefined;
  return { sub, clientId, organizationId: organizationId ?? null };
}

type ClosableTransport = {
  close: () => Promise<void>;
};

type SessionEntry<T extends ClosableTransport> = {
  transport: T;
  owner: SessionOwner;
  lastSeenAt: number;
  inFlight: number;
};

type SessionRemovalReason = 'closed' | 'expired' | 'shutdown';

type SessionRegistryOptions = {
  idleTtlMs: number;
  maxSessions: number;
  now?: () => number;
  onCloseError?: (error: unknown) => void;
  onRemove?: (sessionId: string, reason: SessionRemovalReason) => void;
};

type SessionLease<T extends ClosableTransport> = {
  transport: T;
  release: () => void;
};

type SessionStats = {
  active: number;
  pending: number;
  inFlight: number;
  created: number;
  expired: number;
  closed: number;
  rejected: number;
};

export class SessionRegistry<T extends ClosableTransport> {
  readonly #entries = new Map<string, SessionEntry<T>>();
  readonly #idleTtlMs: number;
  readonly #maxSessions: number;
  readonly #now: () => number;
  readonly #onCloseError: (error: unknown) => void;
  readonly #onRemove: (sessionId: string, reason: SessionRemovalReason) => void;
  #pending = 0;
  #accepting = true;
  #created = 0;
  #expired = 0;
  #closed = 0;
  #rejected = 0;

  constructor(options: SessionRegistryOptions) {
    this.#idleTtlMs = options.idleTtlMs;
    this.#maxSessions = options.maxSessions;
    this.#now = options.now ?? Date.now;
    this.#onCloseError = options.onCloseError ?? (() => undefined);
    this.#onRemove = options.onRemove ?? (() => undefined);
  }

  get size(): number {
    return this.#entries.size;
  }

  stopAccepting(): void {
    this.#accepting = false;
  }

  reserve():
    | {
        commit: (sessionId: string, transport: T, owner: SessionOwner) => SessionLease<T>;
        release: () => void;
      }
    | undefined {
    if (!this.#accepting) return undefined;
    if (this.#entries.size + this.#pending >= this.#maxSessions) {
      this.#rejected += 1;
      return undefined;
    }

    this.#pending += 1;
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      this.#pending -= 1;
    };

    return {
      commit: (sessionId, transport, owner) => {
        if (!active) throw new Error('Session reservation has already been released');
        if (!this.#accepting) {
          release();
          throw new Error('Session registry is shutting down');
        }
        release();
        const entry = {
          transport,
          owner: { ...owner },
          lastSeenAt: this.#now(),
          inFlight: 0,
        };
        this.#entries.set(sessionId, entry);
        this.#created += 1;
        return this.#createLease(entry);
      },
      release,
    };
  }

  acquire(sessionId: string, owner: SessionOwner): SessionLease<T> | undefined {
    const entry = this.#entries.get(sessionId);
    // Deny before touching activity or handing the transport to HTTP dispatch.
    if (
      !entry ||
      entry.owner.sub !== owner.sub ||
      entry.owner.clientId !== owner.clientId ||
      entry.owner.organizationId !== owner.organizationId
    )
      return undefined;
    return this.#createLease(entry);
  }

  #createLease(entry: SessionEntry<T>): SessionLease<T> {
    entry.inFlight += 1;
    entry.lastSeenAt = this.#now();
    let active = true;

    return {
      transport: entry.transport,
      release: () => {
        if (!active) return;
        active = false;
        entry.inFlight -= 1;
        entry.lastSeenAt = this.#now();
      },
    };
  }

  async remove(
    sessionId: string,
    reason: SessionRemovalReason,
    closeTransport = true,
  ): Promise<boolean> {
    const entry = this.#entries.get(sessionId);
    if (!entry) return false;

    this.#entries.delete(sessionId);
    if (reason === 'expired') this.#expired += 1;
    if (reason === 'closed') this.#closed += 1;
    try {
      this.#onRemove(sessionId, reason);
    } catch (error) {
      this.#reportError(error);
    }

    if (closeTransport) {
      try {
        await entry.transport.close();
      } catch (error) {
        this.#reportError(error);
      }
    }
    return true;
  }

  #reportError(error: unknown): void {
    try {
      this.#onCloseError(error);
    } catch {
      // Observer failures must never interrupt session cleanup.
    }
  }

  async sweep(): Promise<number> {
    const now = this.#now();
    const expiredIds = [...this.#entries.entries()]
      .filter(([, entry]) => entry.inFlight === 0 && now - entry.lastSeenAt > this.#idleTtlMs)
      .map(([sessionId]) => sessionId);

    await Promise.all(expiredIds.map((sessionId) => this.remove(sessionId, 'expired')));
    return expiredIds.length;
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.#entries.keys()].map((sessionId) => this.remove(sessionId, 'shutdown')),
    );
  }

  stats(): SessionStats {
    return {
      active: this.#entries.size,
      pending: this.#pending,
      inFlight: [...this.#entries.values()].reduce((sum, entry) => sum + entry.inFlight, 0),
      created: this.#created,
      expired: this.#expired,
      closed: this.#closed,
      rejected: this.#rejected,
    };
  }
}
