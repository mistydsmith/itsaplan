import { sql } from 'drizzle-orm';
import type { DbExecutor } from './client';

// The lease a claim takes. It matches the lease the agent run and chat queues already
// use (AGENT_RUN_LEASE_SECONDS and AGENT_CHAT_LEASE_SECONDS both default to 300), but it
// is its own constant: a claim here is not tied to any run's tuning and reads no
// environment knob. Nothing a caller passes can change it.
export const DEFAULT_ISSUE_CLAIM_LEASE_SECONDS = 300;

// The transaction half of DbExecutor. A claim must join its caller's transaction, so the
// plain client is not accepted: taking the row lock and the writing statement apart from
// the caller's other work would let two participants disagree about one issue.
export type ClaimTransaction = Parameters<Parameters<DbExecutor['transaction']>[0]>[0];

export type ClaimRefusalCode =
  | 'invalid-argument'
  | 'missing-row'
  | 'stale-epoch'
  | 'live-other-owner'
  | 'not-claimed'
  | 'not-expired'
  | 'expired-lease'
  | 'wrong-owner';

export interface ClaimState {
  owner: string | null;
  epoch: number;
  expiresAt: Date | null;
}

export interface ClaimOutcome {
  ok: true;
  // The row after the operation, as the database holds it.
  claim: ClaimState;
  // The row before it, and whether the lease had lapsed when the operation read it.
  previous: ClaimState & { expired: boolean };
  // True when nothing was written: a live claim by the same actor at the same epoch.
  unchanged: boolean;
}

export interface ClaimRefusal {
  ok: false;
  code: ClaimRefusalCode;
  message: string;
  // What the row actually holds, so a caller can rebuild its facts without a second read.
  authoritative: (ClaimState & { expired: boolean }) | null;
}

export type ClaimResult = ClaimOutcome | ClaimRefusal;

interface ClaimRow {
  claim_owner: string | null;
  claim_epoch: number | string;
  claim_expires_at: Date | string | null;
}

// Owner, epoch and deadline only. Expiry is decided in this module on a clock read after
// the row lock is held, never by an expression in the locking statement: those
// expressions may be evaluated before LockRows has finished waiting for the row.
const ROW_COLUMNS = sql`claim_owner, claim_epoch, claim_expires_at`;

// A raw execute() returns a timestamp column as a string, so every read passes through
// here and everything above this line deals in Dates.
function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function state(row: ClaimRow, dbNow: Date): ClaimState & { expired: boolean } {
  const expiresAt = toDate(row.claim_expires_at);
  return {
    owner: row.claim_owner,
    epoch: Number(row.claim_epoch),
    expiresAt,
    // The boundary is inclusive: a deadline at or before the server's clock has lapsed.
    expired: expiresAt !== null && expiresAt.getTime() <= dbNow.getTime(),
  };
}

function refuse(
  code: ClaimRefusalCode,
  message: string,
  authoritative: (ClaimState & { expired: boolean }) | null = null,
): ClaimRefusal {
  return { ok: false, code, message, authoritative };
}

// One exact actor string: non-empty, and no surrounding whitespace of any kind. Case is
// kept as given, because the identity is the server's, not a normalised display name.
function checkActor(actor: unknown): string | null {
  if (typeof actor !== 'string' || actor.length === 0) return null;
  if (actor !== actor.trim() || actor.trim().length === 0) return null;
  return actor;
}

function checkEpoch(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function checkIssueId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

type Operation = 'claim' | 'reclaim' | 'heartbeat' | 'release';

// The server's current time, read as its own statement. It is used only after the issue
// row lock is held, so a transaction that waited for that lock reads the moment it
// resumed rather than the moment it began.
async function databaseNow(tx: ClaimTransaction): Promise<Date> {
  const [clock] = (await tx.execute(sql`SELECT clock_timestamp() AS db_now`)) as unknown as {
    db_now: Date | string;
  }[];
  return toDate(clock.db_now) as Date;
}

// Locks the exact issue row and returns it with the clock as it stands once the lock is
// held. Nothing the caller passes is treated as authority about time or ownership.
async function lockAndRead(
  tx: ClaimTransaction,
  issueId: number,
): Promise<{ row: ClaimRow; dbNow: Date } | null> {
  const rows = (await tx.execute(
    sql`SELECT ${ROW_COLUMNS} FROM issue WHERE id = ${issueId} FOR UPDATE`,
  )) as unknown as ClaimRow[];
  const row = rows[0];
  if (!row) return null;
  return { row, dbNow: await databaseNow(tx) };
}

async function write(
  tx: ClaimTransaction,
  issueId: number,
  expectedEpoch: number,
  owner: string | null,
  leaseSeconds: number | null,
  nextEpoch: number,
): Promise<ClaimState | null> {
  // The epoch in the WHERE is the compare in the swap: if anyone moved the row between
  // the read and this write, the statement matches nothing and the caller is told so
  // instead of being retried behind its back. A fresh deadline is computed on the
  // server's live clock, not on the transaction's start time.
  const rows = (await tx.execute(
    sql`UPDATE issue
           SET claim_owner = ${owner},
               claim_epoch = ${nextEpoch},
               claim_expires_at = ${
                 leaseSeconds === null
                   ? null
                   : sql`clock_timestamp() + make_interval(secs => ${leaseSeconds})`
               }
         WHERE id = ${issueId} AND claim_epoch = ${expectedEpoch}
        RETURNING claim_owner, claim_epoch, claim_expires_at`,
  )) as unknown as ClaimRow[];
  const row = rows[0];
  if (!row) return null;
  return state(row, await databaseNow(tx));
}

async function run(
  tx: ClaimTransaction,
  operation: Operation,
  issueId: number,
  actor: string,
  expectedEpoch: number,
): Promise<ClaimResult> {
  const locked = await lockAndRead(tx, issueId);
  if (!locked) return refuse('missing-row', `Issue ${issueId} does not exist.`);
  const before = state(locked.row, locked.dbNow);
  if (before.epoch !== expectedEpoch) {
    return refuse(
      'stale-epoch',
      `Issue ${issueId} is at epoch ${before.epoch}, not ${expectedEpoch}; rebuild the facts and try again.`,
      before,
    );
  }

  const live = before.owner !== null && !before.expired;

  if (operation === 'claim') {
    if (live && before.owner === actor) {
      // A live claim by the same actor is the same claim: keep the epoch and the
      // deadline exactly as they are, so a retry cannot extend or revive a lease.
      return { ok: true, claim: before, previous: before, unchanged: true };
    }
    if (live) {
      return refuse(
        'live-other-owner',
        `Issue ${issueId} is held by another actor until ${before.expiresAt?.toISOString() ?? 'later'}.`,
        before,
      );
    }
  }

  if (operation === 'reclaim') {
    if (before.owner === null) {
      return refuse('not-claimed', `Issue ${issueId} has no claim to reclaim.`, before);
    }
    if (!before.expired) {
      return refuse(
        'not-expired',
        `The claim on issue ${issueId} is still live; it cannot be reclaimed before it lapses.`,
        before,
      );
    }
  }

  if (operation === 'heartbeat') {
    if (before.owner === null) {
      return refuse('not-claimed', `Issue ${issueId} has no claim to heartbeats.`, before);
    }
    if (before.owner !== actor) {
      return refuse('wrong-owner', `Issue ${issueId} is held by another actor.`, before);
    }
    if (before.expired) {
      return refuse(
        'expired-lease',
        `The claim on issue ${issueId} has lapsed; reclaim it instead of extending it.`,
        before,
      );
    }
  }

  if (operation === 'release' && before.owner !== actor) {
    if (before.owner === null)
      return refuse('not-claimed', `Issue ${issueId} has no claim to release.`, before);
    return refuse('wrong-owner', `Issue ${issueId} is held by another actor.`, before);
  }

  const clears = operation === 'release';
  // A heartbeat moves the deadline and nothing else; every other accepted path moves the
  // epoch by exactly one.
  const nextEpoch = operation === 'heartbeat' ? before.epoch : before.epoch + 1;
  const written = await write(
    tx,
    issueId,
    expectedEpoch,
    clears ? null : actor,
    clears ? null : DEFAULT_ISSUE_CLAIM_LEASE_SECONDS,
    nextEpoch,
  );
  if (!written) {
    return refuse(
      'stale-epoch',
      `Issue ${issueId} changed while it was being written; rebuild the facts and try again.`,
      before,
    );
  }
  return { ok: true, claim: written, previous: before, unchanged: false };
}

export interface ClaimInput {
  issueId: unknown;
  actor: unknown;
  expectedEpoch: unknown;
}

async function call(
  tx: ClaimTransaction,
  operation: Operation,
  input: ClaimInput,
): Promise<ClaimResult> {
  const issueId = checkIssueId(input.issueId);
  const actor = checkActor(input.actor);
  const expectedEpoch = checkEpoch(input.expectedEpoch);
  if (issueId === null) return refuse('invalid-argument', 'issueId must be a positive integer.');
  if (actor === null) {
    return refuse(
      'invalid-argument',
      'actor must be one non-empty string without surrounding whitespace.',
    );
  }
  if (expectedEpoch === null) {
    return refuse('invalid-argument', 'expectedEpoch must be an integer of zero or more.');
  }
  // The lease is this module's constant. Any other property a caller puts on the input
  // object is ignored deliberately: there is no supported way to tune the deadline.
  return run(tx, operation, issueId, actor, expectedEpoch);
}

// Takes the claim on an unclaimed or lapsed issue. A live claim by the same actor is
// returned untouched; a live claim by anyone else refuses.
export function claimIssue(tx: ClaimTransaction, input: ClaimInput): Promise<ClaimResult> {
  return call(tx, 'claim', input);
}

// Takes over a claim that has lapsed, by any actor including the one that let it lapse.
export function reclaimIssue(tx: ClaimTransaction, input: ClaimInput): Promise<ClaimResult> {
  return call(tx, 'reclaim', input);
}

// Extends a live claim held by the same actor at the same epoch.
export function heartbeatClaim(tx: ClaimTransaction, input: ClaimInput): Promise<ClaimResult> {
  return call(tx, 'heartbeat', input);
}

// Drops a claim held by the same actor at the same epoch, lapsed or not, and clears the
// owner and the deadline together.
export function releaseClaim(tx: ClaimTransaction, input: ClaimInput): Promise<ClaimResult> {
  return call(tx, 'release', input);
}
