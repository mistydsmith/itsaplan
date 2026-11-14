// scripts/landing-slot.ts — sentinel-prod-8429 auto-lander unit 2: the landing slot.
//
// WHY a session advisory lock and not a lease table: a lease needs a TTL, a sweeper and a steal rule,
// and every one of those is a new way for two landings to run at once. A PostgreSQL session advisory
// lock has no rows to migrate, no clock to trust and no stealing: the lock exists while the session
// that took it exists, and the server drops it when that session closes. Nothing in Git or on the
// network runs inside SQL, and no transaction is held across those calls.
//
// WHY the driver is injected: this module must be provable with no database. A fake driver proves the
// protocol - which statements run, with which parameters, in which order, and what happens on every
// failure path. It does NOT prove that two real processes exclude each other; that needs a real
// dedicated connection and a two-process test under Root's GO, and is deliberately a separate claim.
//
// WHY the lock key comes from a configured repository identity and not a path: the same repository is
// checked out at different paths on different hosts, so a path-derived key would let two landings on
// the same repository run at once. The identity is normalised and hashed, so identical identities give
// identical keys everywhere and different repositories never collide by accident.

import { createHash } from 'node:crypto';

/** The minimum a dedicated session must do. A pooled client that hands back a shared connection is
 *  wrong here: advisory locks are per session, so release and close must act on the same one. */
export interface SlotSession {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

/** A dedicated-connection factory. The caller owns nothing until it asks for one session. */
export interface SlotDriver {
  connect(): Promise<SlotSession>;
}

export type SlotCode =
  | 'REPO_IDENTITY_MISSING'
  | 'SLOT_BUSY'
  | 'ACQUISITION_FAILED'
  | 'CALLBACK_FAILED'
  | 'RELEASE_FAILED';

export interface SlotOutcome<T> {
  /** True only when this call held the lock and the callback ran. */
  acquired: boolean;
  code?: SlotCode;
  value?: T;
  /** The callback's own error, preserved verbatim when it threw. */
  error?: unknown;
  /** True only when the unlock was attempted on a session this call acquired and reported success. */
  released: boolean;
  /** A release or close failure, reported beside the outcome so it can never read as a clean pass. */
  cleanup?: string;
}

const LOCK_SQL = 'SELECT pg_try_advisory_lock($1) AS held';
const UNLOCK_SQL = 'SELECT pg_advisory_unlock($1) AS released';
/** Signed 63-bit range keeps the key valid for PostgreSQL's bigint advisory-lock variants. */
const KEY_MASK = (1n << 63n) - 1n;

/** Repository identity as configured. Empty or whitespace is refused, never defaulted. */
export function normaliseRepoIdentity(identity: unknown): string {
  return typeof identity === 'string' ? identity.trim() : '';
}

/**
 * The stable key for one repository identity. WHY a hash and not the identity's bytes: the identity is
 * a name ("sentinel-prod"), while the lock needs a number, and hashing keeps the mapping fixed across
 * hosts, paths and processes. WHY masked to 63 bits: PostgreSQL's advisory locks take a signed bigint.
 */
export function slotKey(repoIdentity: string): bigint {
  const normalised = normaliseRepoIdentity(repoIdentity);
  if (!normalised) throw new Error('repository identity is empty, so no slot key exists');
  const digest = createHash('sha256').update(normalised).digest();
  return BigInt(`0x${digest.subarray(0, 8).toString('hex')}`) & KEY_MASK;
}

/**
 * Reads one boolean out of a result. WHY the column is named: pg_try_advisory_lock returns `held` and
 * pg_advisory_unlock returns `released`, so accepting either name everywhere would let an unlock-shaped
 * reply pose as a successful acquisition and run the work without the lock ever being taken.
 */
function columnBool(result: unknown, column: 'held' | 'released'): boolean | null {
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0];
  // Positional rows stay supported: the driver decides the shape, this reads one boolean.
  if (Array.isArray(first)) return first[0] === true ? true : first[0] === false ? false : null;
  if (typeof first !== 'object' || first === null) return null;
  const value = (first as Record<string, unknown>)[column];
  return value === true ? true : value === false ? false : null;
}

/**
 * Runs `fn` while holding the repository's landing slot.
 *
 * The protocol is deliberately narrow: try the lock once (no retry, no wait, no stealing), run the
 * callback only when this call holds it, then unlock and close in `finally` whatever the callback did.
 * A callback error is preserved; a release or close error is reported beside it, so the two are never
 * confused and a failed cleanup can never be mistaken for a clean landing.
 */
export async function withLandingSlot<T>(
  driver: SlotDriver,
  repoIdentity: string,
  fn: () => Promise<T>,
): Promise<SlotOutcome<T>> {
  const identity = normaliseRepoIdentity(repoIdentity);
  // WHY refuse before connecting: an empty identity would hash to one shared key for every caller.
  if (!identity) return { acquired: false, code: 'REPO_IDENTITY_MISSING', released: false };

  let session: SlotSession;
  try {
    session = await driver.connect();
  } catch (error) {
    // WHY the error is not folded into cleanup: a connect failure and a close failure are different
    // facts, and overwriting the first with the second loses what actually stopped the landing.
    return { acquired: false, code: 'ACQUISITION_FAILED', released: false, error };
  }

  const key = slotKey(identity);
  let sessionClosed = false;
  const closeSession = async (): Promise<string | undefined> => {
    if (sessionClosed) return undefined;
    sessionClosed = true;
    try {
      await session.end();
      return undefined;
    } catch (error) {
      return `session close failed: ${String(error)}`;
    }
  };

  let locked: boolean | null = null;
  try {
    locked = columnBool(await session.query(LOCK_SQL, [key]), 'held');
  } catch (error) {
    // WHY the connection still closes: a failed acquisition leaves nothing to hold, and a leaked
    // session would keep an advisory lock alive on the server for as long as the socket lives.
    const cleanup = await closeSession();
    // WHY the error stands on its own: the lock query failing and the close failing are two facts, and
    // folding the first into cleanup text loses what actually stopped the landing.
    return { acquired: false, code: 'ACQUISITION_FAILED', released: false, error, cleanup };
  }

  if (locked !== true) {
    const cleanup = await closeSession();
    // Busy is not an error to clean up after: nothing was acquired, so nothing is unlocked.
    return { acquired: false, code: 'SLOT_BUSY', released: false, cleanup };
  }

  let outcome: SlotOutcome<T> = { acquired: true, released: false };
  try {
    outcome = { acquired: true, released: false, value: await fn() };
  } catch (error) {
    // WHY the code is always set: `throw undefined` and `return undefined` are different events, and
    // without an explicit code a thrown undefined reads exactly like a successful undefined return.
    outcome = { acquired: true, released: false, error, code: 'CALLBACK_FAILED' };
  }

  const cleanupParts: string[] = [];
  try {
    const released = columnBool(await session.query(UNLOCK_SQL, [key]), 'released');
    // WHY false is a failure: the lock was not released, so the next landing would be refused while
    // nothing is actually running. Reporting it as a pass would hide a stuck slot.
    if (released !== true) cleanupParts.push('the slot did not report a successful unlock');
    else outcome.released = true;
  } catch (error) {
    cleanupParts.push(`unlock failed: ${String(error)}`);
  }
  const closeFailure = await closeSession();
  if (closeFailure) cleanupParts.push(closeFailure);

  if (cleanupParts.length > 0) {
    outcome = { ...outcome, cleanup: cleanupParts.join('; ') };
    // WHY only when nothing else failed: the release failure is reported beside the work, and a
    // callback failure keeps its own code rather than being relabelled by cleanup.
    if (outcome.code === undefined) outcome.code = 'RELEASE_FAILED';
  }
  return outcome;
}
