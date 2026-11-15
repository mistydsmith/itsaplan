// The native RecordStorage of a landing: issue, project_column and issue_activity on one
// transaction.
//
// WHY it is in apps/api: the ORM and the '#shared/*' aliases exist only in this package. The
// coordinator in scripts/landing-record.ts owns the order and the refusal rules; this file
// imports its RecordStorage and RecordTx types and restates none of them.
//
// WHY the move goes through updateIssue: it is the one writer of a column change. On a project
// with a rig it asks the rule owner for the close, observes the commit, judges the claim,
// releases it and writes the status stretch, the activity and the queued rows, all on the
// executor it is given. A column write made here would skip every one of those.
import { issue, issueActivity, lockIssueTree, projectColumn, type DbExecutor } from '@repo/db';
import { eq, sql } from 'drizzle-orm';

import {
  cleanupPayload,
  landingPayload,
  landingsOnly,
} from '../../../../../scripts/landing-native-record';
import type {
  LandingActivityRow,
  RecordStorage,
  RecordTx,
} from '../../../../../scripts/landing-record';
import { recordActivityEntries } from './activity';
import { closeRepoFor, type CloseRequest } from './close-facts';
import { updateIssue } from './service';

export interface LockedIssue {
  issueId: number;
  columnId: number | null;
  projectId: number;
  archivedAt: Date | null;
  stateType: string | null;
  claimEpoch: number;
  // The rig the project holds under its lock, with the prefix the rule manifest keys on.
  rig: { id: number; prefix: string } | null;
}

type Rows<T> = T[];

// Locks the rig, the board and the project before the issue, the order updateIssue's gated
// write takes them in.
//
// WHY the same order: the coordinator reads the item first, so this is the first lock of the
// transaction. An issue lock taken alone here, with updateIssue asking for the rig afterwards,
// deadlocks against a gated write that holds the rig and waits for the issue.
async function lockProjectOf(
  tx: DbExecutor,
  projectId: number,
): Promise<{ id: number; prefix: string } | null> {
  const hint = (await tx.execute(
    sql`SELECT rig_id FROM project WHERE id = ${projectId}`,
  )) as unknown as Rows<{ rig_id: number | string | null }>;
  const hinted = hint[0]?.rig_id ?? null;
  if (hinted === null) {
    // WHY the project is held here too: a rig given to the project after this read would make
    // the move a gated write that takes the rig after the issue this transaction already holds.
    const ordinary = (await tx.execute(
      sql`SELECT rig_id FROM project WHERE id = ${projectId} FOR SHARE`,
    )) as unknown as Rows<{ rig_id: number | string | null }>;
    if (ordinary.length === 0 || ordinary[0].rig_id !== null)
      throw new Error(`project ${projectId} changed its rig while the landing was being recorded`);
    return null;
  }
  const rigs = (await tx.execute(
    sql`SELECT id, prefix FROM rig WHERE id = ${Number(hinted)} FOR UPDATE`,
  )) as unknown as Rows<{ id: number | string; prefix: string }>;
  await lockIssueTree(tx, projectId);
  const held = (await tx.execute(
    sql`SELECT rig_id FROM project WHERE id = ${projectId} FOR UPDATE`,
  )) as unknown as Rows<{ rig_id: number | string | null }>;
  if (rigs.length === 0 || Number(held[0]?.rig_id) !== Number(rigs[0].id))
    throw new Error(`project ${projectId} changed its rig while the landing was being recorded`);
  return { id: Number(rigs[0].id), prefix: rigs[0].prefix };
}

// The issue of a bead id, locked. bead_id has a partial unique index and never changes once
// set, so it names one issue.
export async function lockIssueByBeadId(
  tx: DbExecutor,
  beadId: string,
): Promise<LockedIssue | null> {
  const found = await tx
    .select({ projectId: issue.projectId })
    .from(issue)
    .where(eq(issue.beadId, beadId));
  if (found.length === 0) return null;
  const rig = await lockProjectOf(tx, found[0].projectId);
  // FOR UPDATE names the issue alias: PostgreSQL refuses to lock the nullable side of a LEFT JOIN.
  const rows = await tx
    .select({
      issueId: issue.id,
      columnId: issue.columnId,
      projectId: issue.projectId,
      archivedAt: issue.archivedAt,
      stateType: projectColumn.stateType,
      claimEpoch: issue.claimEpoch,
    })
    .from(issue)
    .leftJoin(projectColumn, eq(projectColumn.id, issue.columnId))
    .where(eq(issue.beadId, beadId))
    .for('update', { of: issue });
  if (rows.length === 0) return null;
  if (rows[0].projectId !== found[0].projectId)
    throw new Error(`issue for ${beadId} moved projects while the landing was being recorded`);
  return { ...rows[0], claimEpoch: Number(rows[0].claimEpoch), rig };
}

// The configured completed column, read and held FOR SHARE until commit: a column can be re-typed,
// deleted or moved to another project while the landing waits, and after this check as well.
export async function lockedCompletedColumn(
  tx: DbExecutor,
  projectId: number,
  columnId: number,
): Promise<{ ok: true } | { ok: false; code: string; reason: string }> {
  const rows = await tx
    .select({ projectId: projectColumn.projectId, stateType: projectColumn.stateType })
    .from(projectColumn)
    .where(eq(projectColumn.id, columnId))
    .for('share');
  if (rows.length === 0)
    return { ok: false, code: 'COLUMN_MISSING', reason: `no column has id ${columnId}` };
  const [column] = rows;
  if (column.projectId !== projectId)
    return {
      ok: false,
      code: 'COLUMN_WRONG_PROJECT',
      reason: `column ${columnId} belongs to project ${column.projectId}, not ${projectId}`,
    };
  if ((column.stateType ?? '').trim().toLowerCase() !== 'completed')
    return {
      ok: false,
      code: 'COLUMN_NOT_COMPLETED',
      reason: `column ${columnId} is ${column.stateType}, not completed`,
    };
  return { ok: true };
}

interface PendingMove {
  itemKey: string;
  fromColumnId: number | null;
  toColumnId: number;
}

// The close request of a landing on a project with a rig, or a throw before any write.
async function closeRequestFor(
  locked: LockedIssue & { rig: { id: number; prefix: string } },
  row: LandingActivityRow,
  closeRepoKey: string,
): Promise<CloseRequest> {
  const repo = await closeRepoFor(locked.rig.prefix, closeRepoKey);
  if (repo === undefined)
    throw new Error(
      `CLOSE_REPO_UNKNOWN: the rule manifest names no repo ${closeRepoKey} for rig ${locked.rig.prefix}`,
    );
  if (row.payload.targetRef !== repo.targetRef)
    throw new Error(
      `CLOSE_REF_MISMATCH: the landing published to ${String(row.payload.targetRef)}, and repo ${closeRepoKey} closes on ${repo.targetRef}`,
    );
  return {
    kind: 'code',
    reason: row.body,
    repo: closeRepoKey,
    sha: row.payload.candidateSha,
    expectedEpoch: locked.claimEpoch,
  };
}

function nativeTx(tx: DbExecutor, options: NativeRecordStorageOptions) {
  const { completedColumnId, closeRepoKey, closerUserId } = options;
  // WHY the move waits for the append: the coordinator calls moveItem before appendActivity,
  // and the close needs the commit and the branch that only the appended row carries. moveItem
  // answers the compare-and-set on the locked row, which no other writer can change before the
  // write, and appendActivity makes the move and then the record on the same transaction.
  let pending: PendingMove | null = null;

  async function appendLanding(issueId: number, row: LandingActivityRow) {
    // The record keeps the lane as its actor. The closer of the move is the authenticated user.
    await recordActivityEntries(
      // recordActivityEntries stores extra payload keys; its ActivityPayload type is closed.
      [{ issueId, event: { action: row.action, ...landingPayload(row) } as never }],
      { system: row.actorName },
      tx,
    );
  }

  const record: RecordTx = {
    async readActivities(itemKey) {
      const locked = await lockIssueByBeadId(tx, itemKey);
      if (locked === null) return [];
      const rows = await tx
        .select({ payload: issueActivity.payload })
        .from(issueActivity)
        .where(eq(issueActivity.issueId, locked.issueId));
      return landingsOnly(rows.map((entry) => entry.payload));
    },
    async readItem(itemKey) {
      const locked = await lockIssueByBeadId(tx, itemKey);
      if (locked === null) return null;
      return {
        columnId: locked.columnId,
        projectId: locked.projectId,
        status: (locked.stateType ?? 'unstarted').trim().toLowerCase(),
        archived: locked.archivedAt != null,
      };
    },
    async moveItem(itemKey, fromColumnId, toColumnId) {
      if (toColumnId !== completedColumnId)
        throw new Error(
          `COLUMN_MISMATCH: the landing completes into column ${toColumnId}, and this storage is configured for ${completedColumnId}`,
        );
      const locked = await lockIssueByBeadId(tx, itemKey);
      if (locked === null) return false;
      const column = await lockedCompletedColumn(tx, locked.projectId, completedColumnId);
      if (!column.ok) throw new Error(`${column.code}: ${column.reason}`);
      if (locked.columnId !== fromColumnId) return false;
      pending = { itemKey, fromColumnId, toColumnId };
      return true;
    },
    async appendActivity(row) {
      const locked = await lockIssueByBeadId(tx, row.itemKey);
      if (locked === null) throw new Error(`issue for ${row.itemKey} disappeared under the lock`);
      const move = pending;
      if (move === null) return appendLanding(locked.issueId, row);
      if (move.itemKey !== row.itemKey)
        throw new Error(`the move of ${move.itemKey} was followed by a record for ${row.itemKey}`);
      pending = null;
      // A project with no rig has no close gate, and updateIssue ignores a close request there.
      const closeRequest =
        locked.rig === null
          ? undefined
          : await closeRequestFor({ ...locked, rig: locked.rig }, row, closeRepoKey);
      const after = await updateIssue(locked.issueId, { columnId: move.toColumnId }, closerUserId, {
        executor: tx,
        onlyIfColumnId: move.fromColumnId ?? undefined,
        closeRequest,
      });
      if (after?.columnId !== move.toColumnId)
        throw new Error(`MOVE_FAILED: ${row.itemKey} was not moved to column ${move.toColumnId}`);
      await appendLanding(locked.issueId, row);
    },
    async recordCleanupObligation(row) {
      const locked = await lockIssueByBeadId(tx, row.itemKey);
      if (locked === null) throw new Error(`issue for ${row.itemKey} disappeared under the lock`);
      await recordActivityEntries(
        [
          {
            issueId: locked.issueId,
            event: { action: 'landing_cleanup_obligation', ...cleanupPayload(row) } as never,
          },
        ],
        { system: 'dsh' },
        tx,
      );
    },
  };
  return { record, unwritten: () => pending };
}

export interface NativeRecordStorageOptions {
  // The configured completed column: explicit, never inferred from the project's columns.
  completedColumnId: number;
  // The authenticated user id of the closer, supplied by the trusted runtime that holds the
  // session. It is never the lane name, a flight field, a request body field or a claim owner
  // read for the purpose: each of those would let a caller close as someone else.
  closerUserId: string;
  // The manifest key of the repo a landing closes against, from close.rigs.<rig>.repos. A
  // landing row carries a branch and no key, and no rule maps one to the other.
  closeRepoKey: string;
  // The client that opens the one transaction.
  client: { transaction: <T>(fn: (tx: DbExecutor) => Promise<T>) => Promise<T> };
}

const blank = (value: unknown) => typeof value !== 'string' || value.trim() === '';

export function nativeRecordStorage(options: NativeRecordStorageOptions): RecordStorage {
  return {
    async transaction<T>(fn: (tx: RecordTx) => Promise<T>): Promise<T> {
      // Before the transaction opens: a landing with no closer or no repo key reads and writes
      // nothing.
      if (blank(options.closerUserId))
        throw new Error('closerUserId is not configured, so this landing has no closer');
      if (blank(options.closeRepoKey))
        throw new Error('closeRepoKey is not configured, so this landing names no repo to close');
      if (typeof options.client?.transaction !== 'function')
        throw new Error('no transaction-capable client was supplied, so nothing is recorded');
      return options.client.transaction(async (tx) => {
        const native = nativeTx(tx, options);
        const result = await fn(native.record);
        // A move the coordinator was told succeeded and that no record followed is rolled back.
        if (native.unwritten() !== null)
          throw new Error('a completed move was answered and no landing record followed it');
        return result;
      });
    },
  };
}
