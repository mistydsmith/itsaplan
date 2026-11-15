// packages/db/src/landing-slot-driver.ts — sentinel-prod-8429 atom B: the dedicated postgres session driver.
//
// WHY this lives in packages/db and not scripts/: this is the only package in the workspace that DECLARES a postgres client,
// so a leaf under scripts/ cannot resolve a driver at all. The type-only policy module scripts/landing-slot.ts stays where it
// is; this file is the transport it was always meant to be handed.
//
// WHY the driver is a separate file from the slot policy, and holds NO policy: the lock key, the try/unlock protocol, the
// release and close reporting and every outcome code belong to scripts/landing-slot.ts and are covered there. If this file
// grew a second copy of any of them, the two could drift and a landing could believe it held a lock it never took. What is
// here is only: open one dedicated session, pass statements through, close it.
//
// WHY a dedicated connection and not a pooled one: PostgreSQL advisory locks are per SESSION. A pooled client that hands
// back a different connection on the next call would release, or fail to release, somebody else's lock. So each connect()
// opens its own client with max: 1 - one connection, used for every statement until end().
//
// PROVENANCE: this transport is the same one that ran in the accepted two-process witness
// (packages/db/src/__tests__/landing-slot.integration.child.ts, blobs aaf6f907 / eec3370f), where two real processes
// excluded each other on a real database. Extracting it changes its address, not its behaviour.

/** The minimum a dedicated session must do. Shaped to match the policy's SlotSession without importing it. */
export interface DedicatedSlotSession {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

/** A dedicated-connection factory. Nothing is opened until connect() is called. */
export interface DedicatedSlotDriver {
  connect(): Promise<DedicatedSlotSession>;
}

/** The slice of the postgres client this driver uses, so a unit test can answer without a database. */
export interface PostgresSessionLike {
  unsafe(sql: string, params: never[]): Promise<unknown[]>;
  end(options?: { timeout?: number }): Promise<void>;
}

export type PostgresFactory = (url: string, options: { max: number }) => PostgresSessionLike;

export interface DedicatedSlotDriverOptions {
  /** The connection URL for the dedicated session. Required: an empty value is refused, never defaulted. */
  url: string;
  /** Seconds allowed for end(). WHY bounded: a session that never closes would hold the advisory lock forever. */
  closeTimeoutSeconds?: number;
  /** Injection seam for the unit test. Production omits it and the real client is used. */
  postgres?: PostgresFactory;
}

const DEFAULT_CLOSE_TIMEOUT_SECONDS = 5;

/**
 * Builds the driver the landing slot is handed.
 *
 * WHY it refuses an empty URL here rather than at connect(): a driver that exists without a target is a configuration
 * mistake that should surface at start-up, where the operator can still see it, not mid-landing.
 */
export function createDedicatedSlotDriver(
  options: DedicatedSlotDriverOptions,
): DedicatedSlotDriver {
  const url = typeof options.url === 'string' ? options.url.trim() : '';
  if (!url) throw new Error('dedicated slot driver: a connection url is required');
  const closeTimeoutSeconds = options.closeTimeoutSeconds ?? DEFAULT_CLOSE_TIMEOUT_SECONDS;
  if (!Number.isFinite(closeTimeoutSeconds) || closeTimeoutSeconds <= 0) {
    throw new Error(
      `dedicated slot driver: closeTimeoutSeconds must be a positive number, got ${String(
        options.closeTimeoutSeconds,
      )}`,
    );
  }

  return {
    async connect(): Promise<DedicatedSlotSession> {
      const factory = options.postgres ?? (await defaultPostgresFactory());
      // WHY max: 1 on every connect: one advisory lock belongs to one session, and this session must be that one.
      const sql = factory(url, { max: 1 });
      return {
        async query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> {
          // WHY the cast: postgres types unsafe() parameters as its own JSON-or-primitive union while the slot passes through
          // exactly the values it was given, so the array crosses that boundary untyped rather than reshaped. The key is
          // never inlined into the statement: it arrives as a parameter.
          const rows = await sql.unsafe(text, (params ?? []) as never[]);
          return { rows };
        },
        async end(): Promise<void> {
          await sql.end({ timeout: closeTimeoutSeconds });
        },
      };
    },
  };
}

/** Loads the workspace's declared client. WHY dynamic: the driver object itself then stays constructible without a client. */
async function defaultPostgresFactory(): Promise<PostgresFactory> {
  const imported = (await import('postgres')) as unknown as {
    default: (url: string, options: { max: number }) => unknown;
  };
  return (url, options) => imported.default(url, options) as PostgresSessionLike;
}
