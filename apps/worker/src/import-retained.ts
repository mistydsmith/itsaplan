// The retained-row machinery (Root 8363.1 retained-row seam, 2026-11-15):
// the source's non-ticket rows (bd's memory/note class) are recorded after
// the last issue chunk, by the existing Create phase, in ONE import
// transaction: the source's afterRetainedRow hook stamps a tombstone identity
// per row (issue_id NULL), and the whole transaction rolls back if any is
// refused - never a partial ledger. The rows' CONTENT (title, unmapped
// fields) is then retained durably into the job's config as a retainedArtifact
// with a SHA-256 digest, so reconciliation can say where every source value
// ended up. A source without non-ticket rows, or without the hook, does
// nothing here. A leaf of its own so the registration and worker monoliths
// stay within the module size guard (Root P0 2026-11-15).
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { IdentityTransaction } from '@repo/db/issue-identity';
import type { CanonicalRetainedRow, SourceReader } from './reader';
import type { ClaimedImportJob } from './import-store';
import { afterRetainedRowForJob } from './import-sources';

export interface RetainedArtifact {
  digest: string;
  rows: CanonicalRetainedRow[];
}

// Pure: the retained artifact of the rows, digested over the canonical (sorted)
// order so a re-run over the same board produces the same digest. It lives here
// (not import-worker.ts) so it stays importable without the DB client, which the
// test suites need.
export function retainedArtifactOf(rows: CanonicalRetainedRow[]): RetainedArtifact {
  const stable = [...rows].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const digest = createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  return { digest, rows: stable };
}

// The retained artifact write, transaction-scoped (Office RETURN3 D3, 8363.1):
// the tombstone stamps AND the content receipt must land in ONE commit. The old
// global-db write ran as a separate statement AFTER the hook transaction
// committed, so an artifact-write failure or a crash in between left committed
// tombstones with no durable source-content receipt - and the next tick rebuilds
// a fresh snapshot that may have changed or lost those rows. The caller passes
// its own import transaction; this module stays DB-free (it imports no db
// client), which is what lets the no-DB proofs load it and watch both writes
// land on the same transaction.
// F3 (Root GO 2026-11-15): the UPDATE carries RETURNING id and this function
// throws unless exactly one row landed - a vanished job (zero rows) throws
// INSIDE the transaction, rolling the stamps back with it, so no orphaned
// stamps can exist without their receipt.
export async function saveRetainedArtifact(
  tx: IdentityTransaction,
  jobId: number,
  artifact: RetainedArtifact,
): Promise<void> {
  const rows = (await tx.execute(
    sql`UPDATE import_job
        SET config = jsonb_set(config, '{retainedArtifact}', ${JSON.stringify(artifact)}::jsonb),
            updated_at = now()
      WHERE id = ${jobId}
      RETURNING id`,
  )) as unknown as { id: number }[];
  if (rows.length !== 1)
    throw new Error(
      `retained artifact write failed: expected exactly one import_job row, got ${rows.length}`,
    );
}

// F1 (Root GO 2026-11-15): a crashed-and-retried tick re-reads the board and
// rebuilds the retained rows, so the COMMITTED receipt is the truth, not the
// source. The worker calls this first inside the retained transaction, which
// locks the job's own row (held to the transaction's commit) and then refuses,
// before any stamp or write: a job that is gone, or a committed artifact with a
// DIFFERENT digest - the source was edited or a row removed after the committed
// step, and the receipt is never silently replaced. The same digest is the
// idempotent replay: the stamps re-run idempotently and the write lands again.
export async function assertRetainedArtifactUnchanged(
  tx: IdentityTransaction,
  jobId: number,
  digest: string,
): Promise<void> {
  const rows = (await tx.execute(
    sql`SELECT (config -> 'retainedArtifact' ->> 'digest') AS digest
        FROM import_job WHERE id = ${jobId}
      FOR UPDATE`,
  )) as unknown as { digest: string | null }[];
  if (rows.length === 0)
    throw new Error(`retained rows refused: import job ${jobId} does not exist`);
  const existing = rows[0]!.digest;
  if (existing != null && existing !== digest)
    throw new Error(
      'retained rows refused: the committed artifact has a different digest ' +
        '(the source changed or a row was removed after the committed step) - refusing to replace it',
    );
}

// --- Retained rows (Root, 8363.1 retained-row seam, 2026-11-15): the source's
// non-ticket rows (bd's memory/note class) are recorded after the last issue
// chunk, by the existing Create phase, in ONE import transaction: the source's
// afterRetainedRow hook stamps a tombstone identity per row (issue_id NULL), and
// the whole transaction rolls back if any is refused - never a partial ledger.
// The rows' CONTENT (title, unmapped fields) is then retained durably into the
// job's config as a retainedArtifact with a SHA-256 digest, so reconciliation
// can say where every source value ended up. A source without non-ticket rows,
// or without the hook, does nothing here.
export async function recordRetainedRows(
  job: ClaimedImportJob,
  reader: SourceReader,
): Promise<void> {
  const hook = afterRetainedRowForJob(job);
  // The db client loads LAZILY here (not at module top): this module must stay
  // loadable with no database client at all - the registration re-exports it,
  // and the no-DB proofs load the registration without a connection.
  const { db } = await import('@repo/db');
  if (!hook) return;
  // CT 2026-11-15 fix 2: a reader WITH the port must run the same
  // guard/artifact path even when it lists ZERO rows - if the source removed
  // ALL retained rows after the committed receipt, the empty snapshot's digest
  // differs and the refusal must fire. Early-returning here would bypass it.
  // Sources without the port (other providers) skip entirely.
  const rows = reader.listRetainedRows ? await reader.listRetainedRows() : null;
  if (rows === null) return;
  // ONE transaction commits the tombstone stamps AND the content artifact (Office
  // RETURN3 D3): an artifact-write error or a crash rolls back BOTH, so a
  // committed tombstone can never exist without its durable source-content
  // receipt. The snapshot is read once here and never reread: the receipt is
  // what makes a later tick's changed or lost rows reconcilable.
  // F1 (Root GO 2026-11-15): the transaction first locks the job's own row and
  // refuses a changed source (different committed digest) or a missing job
  // BEFORE any stamp or write - a crashed-and-retried tick that re-reads the
  // board must not silently replace a committed receipt; the same digest is the
  // idempotent replay.
  const artifact = retainedArtifactOf(rows);
  await db.transaction(async (tx) => {
    await assertRetainedArtifactUnchanged(tx, job.id, artifact.digest);
    for (const row of rows) {
      await hook(tx, { jobId: job.id, sourceId: row.sourceId, projectId: job.projectId, row });
    }
    await saveRetainedArtifact(tx, job.id, artifact);
  });
}

// stateOverrides (Plane state id -> itsaplan category) comes from the mapping review
// step at job creation; only newly-created columns are affected, never a dedup-matched
// existing one - createLocalStateAndRecord already never touches an existing match's
// stateType.
