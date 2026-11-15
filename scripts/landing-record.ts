// scripts/landing-record.ts — sentinel-prod-8429 (partial) auto-lander unit 5: record and complete.
// WHY it owns no rule of its own: eligibility and the partial marker come from landing-evidence, the
// landed/published facts from unit 4, and the storage from an injected typed contract - no SQL here.
// WHY one transaction: a record without the completion, or a completion without the record, is a lie
// either way; all three obligations land or none do. WHY the cleanup is a row: this slice deletes
// nothing, it records the obligation for whoever owns the filesystem to act on with its own proof.

import {
  evaluateBundle,
  parseReceipt,
  type ItemState,
  type LandingDecision,
  type LandingReceipt,
  type RefusalCode,
} from './landing-evidence';
import type { PublishResult } from './landing-publish';
/** One project column, as the adapter will read it. stateType is the column's own state class. */
export interface ColumnDescriptor {
  id: number;
  projectId: number;
  stateType: string;
}
/** The item as the adapter sees it. columnId null means the item sits in no column. */
export interface RecordItem {
  itemKey: string;
  projectId: number;
  columnId: number | null;
  status?: string;
  archived?: boolean;
  metadata?: Record<string, unknown>;
}
/** The row shape appends to issue_activity: kind/action/actorName/body/payload. */
export interface LandingActivityRow {
  itemKey: string;
  kind: 'landing_partial' | 'landing_full';
  action: 'landing_recorded';
  actorName: string;
  body: string;
  payload: {
    activityId: string;
    itemKey: string;
    candidateSha: string;
    baseSha: string;
    targetRef: string | null;
    remoteSha: string;
    partial: boolean;
    metadata: Record<string, unknown> | null;
  };
}
/** What a prior landing record looks like when it is read back for idempotency. */
export interface PriorActivity {
  kind: string;
  payload: { activityId?: string; candidateSha?: string; itemKey?: string } | null;
}
export interface CleanupObligationRow {
  itemKey: string;
  candidateSha: string;
  kind: 'landing_cleanup';
  obligation: string;
}
export interface FreshItem {
  columnId: number | null;
  projectId: number;
  status?: string;
  archived?: boolean;
}
/**
 * One transaction against issue_activity. WHY the adapter MUST lock first: the refusals above happen
 * outside any lock, so readItem's fresh read is the only one trusted at write time - lock the item's row,
 * return lifecycle+project+column under it, roll back everything on a throw. The fake serialises callbacks
 * with a promise chain: that models queuing, never a row lock.
 */
/** One transaction against issue_activity. WHY the adapter MUST lock first: the refusals above happen
 *  outside any lock, so readItem's fresh read is the only one trusted at write time - lock the item's
 *  row, return lifecycle+project+column under it, roll back on a throw. The fake's promise chain models
 *  queuing, never a row lock. */
export interface RecordTx {
  readActivities(itemKey: string): Promise<PriorActivity[]>;
  readItem(itemKey: string): Promise<FreshItem | null>;
  appendActivity(row: LandingActivityRow): Promise<void>;
  /** WHY a from-column: the move is a compare-and-set, so it cannot complete an item something moved. */
  moveItem(itemKey: string, fromColumnId: number | null, toColumnId: number): Promise<boolean>;
  recordCleanupObligation(row: CleanupObligationRow): Promise<void>;
}
export interface RecordStorage {
  transaction<T>(fn: (tx: RecordTx) => Promise<T>): Promise<T>;
}
export type RecordCode =
  | 'PUBLICATION_INVALID'
  | 'NOT_PUBLISHED'
  | 'SHA_MISMATCH'
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_MISMATCH'
  | 'ITEM_CANCELED'
  | 'ITEM_ARCHIVED'
  | 'ITEM_MISSING'
  | 'COLUMN_MISSING'
  | 'COLUMN_AMBIGUOUS'
  | 'COLUMN_WRONG_PROJECT'
  | 'COLUMN_NOT_COMPLETED'
  | 'RECORD_CONFLICT'
  | 'MOVE_FAILED'
  | 'STORAGE_FAILED'
  | RefusalCode;
export interface RecordResult {
  recorded: boolean;
  completed: boolean;
  /** True when an identical record already existed and nothing was written again. */
  replayed: boolean;
  partial: boolean;
  code?: RecordCode;
  reason: string;
  activityId?: string;
}
export interface RecordInput {
  /** Unit 4's result: this coordinator will not record anything that was not published. */
  publication: PublishResult;
  item: RecordItem;
  receipts: readonly unknown[];
  verdicts: readonly unknown[];
  /** Explicit, never inferred: the column a FULL landing completes into. */
  completedColumnId: number;
  /** Every column the adapter can see; the configured one must be exactly one of them, same project. */
  columns: readonly ColumnDescriptor[];
  storage: RecordStorage;
  actorName: string;
}
const FULL_SHA = /^[0-9a-f]{40}$/;
const refuse = (code: RecordCode, reason: string, partial = false): RecordResult => ({
  recorded: false,
  completed: false,
  replayed: false,
  partial,
  code,
  reason,
});
class Rollback extends Error {
  constructor(readonly result: RecordResult) {
    super(result.reason);
  }
}

function checkPublication(publication: PublishResult): RecordResult | null {
  if (typeof publication !== 'object' || publication === null)
    return refuse('PUBLICATION_INVALID', 'no publication result was supplied');
  const sha = publication.candidateSha;
  if (!FULL_SHA.test(sha ?? ''))
    return refuse('SHA_MISMATCH', `the publication names no full candidate SHA: ${String(sha)}`);
  if (publication.published !== true || publication.landed !== true)
    return refuse(
      'NOT_PUBLISHED',
      `not published: ${publication.code ?? 'no code'} ${publication.reason}`,
    );
  if (publication.remoteSha !== sha)
    return refuse(
      'SHA_MISMATCH',
      `the remote reports ${String(publication.remoteSha)}, not ${sha}`,
    );
  return null;
}

/**
 * The reviewed receipt, bound to the publication it must describe. WHY not a second eligibility rule:
 * evaluateBundle still decides whether the bundle may land; this checks the bundle it approved is about
 * THIS flight - same candidate, base, item and paths as the Git facts and the remote readback.
 */
function bindEvidence(
  receipts: readonly unknown[],
  publication: PublishResult,
  itemKey: string,
): { receipt: LandingReceipt } | { refusal: string } {
  const parsed: LandingReceipt[] = [];
  for (const raw of receipts) {
    const receipt = parseReceipt(raw);
    if (typeof receipt === 'string') return { refusal: `a receipt is invalid: ${receipt}` };
    parsed.push(receipt);
  }
  if (parsed.length === 0) return { refusal: 'no receipt was supplied' };
  const [first] = parsed;
  const join = (paths: readonly string[]) => [...paths].sort().join('\u0000');
  const sameFlight = (row: LandingReceipt) =>
    row.candidateSha === first.candidateSha &&
    row.baseSha === first.baseSha &&
    row.itemKey === first.itemKey &&
    join(row.allowedPaths) === join(first.allowedPaths);
  if (!parsed.every(sameFlight)) return { refusal: 'the receipts disagree about the candidate' };
  const facts = publication.git?.facts;
  if (facts === undefined) return { refusal: 'the publication carries no Git facts to bind to' };
  // WHY no separate candidate-versus-receipt check: checkPublication forces candidateSha === remoteSha, so
  // comparing the receipt to the readback says the same thing, and one branch is what proves it.
  if (publication.remoteSha !== first.candidateSha)
    return {
      refusal: `remote reports ${String(publication.remoteSha)}, receipt reviewed ${first.candidateSha}`,
    };
  if (first.itemKey !== itemKey)
    return { refusal: `receipt names ${first.itemKey}, item is ${itemKey}` };
  if (facts.candidateSha !== first.candidateSha || facts.baseSha !== first.baseSha)
    return { refusal: `Git facts ${facts.candidateSha}/${facts.baseSha} do not match the receipt` };
  if (join(facts.changedPaths) !== join(first.allowedPaths))
    return { refusal: 'the receipt declares different paths than the candidate changed' };
  return { receipt: first };
}

function checkColumn(input: RecordInput): RecordResult | null {
  const matches = input.columns.filter((column) => column.id === input.completedColumnId);
  if (matches.length === 0)
    return refuse('COLUMN_MISSING', `no column has the configured id ${input.completedColumnId}`);
  if (matches.length > 1)
    return refuse(
      'COLUMN_AMBIGUOUS',
      `${matches.length} columns carry the configured id ${input.completedColumnId}`,
    );
  const [column] = matches;
  if (column.projectId !== input.item.projectId)
    return refuse(
      'COLUMN_WRONG_PROJECT',
      `column ${column.id} belongs to project ${column.projectId}, the item to ${input.item.projectId}`,
    );
  // WHY the state type and not the name: a column called "Done" is not a completion unless it is one.
  if (column.stateType !== 'completed')
    return refuse(
      'COLUMN_NOT_COMPLETED',
      `column ${column.id} is stateType ${column.stateType}, not completed`,
    );
  return null;
}

const sameRecord = (prior: PriorActivity, wanted: LandingActivityRow): boolean =>
  prior.kind === wanted.kind && prior.payload?.activityId === wanted.payload.activityId;

/**
 * Records one published landing, and completes the item only for a full landing.
 *
 * Everything that can be refused is refused BEFORE the transaction opens. Inside it only three things
 * happen, in this order: the record, the move for a full landing, the cleanup obligation for a full
 * landing. A refusal inside throws, the storage rolls back, and the caller sees a typed result.
 */
export async function recordLanding(input: RecordInput): Promise<RecordResult> {
  const publicationRefusal = checkPublication(input.publication);
  if (publicationRefusal) return publicationRefusal;
  const candidateSha = input.publication.candidateSha as string;
  const baseSha = input.publication.evidence?.code
    ? ''
    : String(input.publication.git?.facts?.baseSha ?? '');
  // WHY the Git-read subject: the same one unit 4 proved, so the record and the publication cannot
  // describe the candidate differently.
  const subject = input.publication.git?.facts?.subject;
  if (typeof subject !== 'string' || subject.trim() === '')
    return refuse(
      'EVIDENCE_MISSING',
      'the publication carries no Git-read subject to record against',
    );

  const binding = bindEvidence(input.receipts, input.publication, input.item.itemKey);
  if ('refusal' in binding) return refuse('EVIDENCE_MISMATCH', binding.refusal);

  const item: ItemState = {
    itemKey: input.item.itemKey,
    status: input.item.status,
    archived: input.item.archived,
  };
  const evidence: LandingDecision = evaluateBundle(item, subject, input.receipts, input.verdicts);
  if (!evidence.eligible) {
    return refuse(evidence.code ?? 'RECORD_CONFLICT', evidence.reason, evidence.partial);
  }
  const partial = evidence.partial;
  if (!partial) {
    const columnRefusal = checkColumn(input);
    if (columnRefusal) return columnRefusal;
  }

  const activityId = `${input.item.itemKey}:${candidateSha}`;
  const row: LandingActivityRow = {
    itemKey: input.item.itemKey,
    kind: partial ? 'landing_partial' : 'landing_full',
    action: 'landing_recorded',
    actorName: input.actorName,
    body: partial
      ? `landing ${candidateSha} recorded (partial): the item stays where it is`
      : `landing ${candidateSha} recorded and item completed`,
    payload: {
      activityId,
      itemKey: input.item.itemKey,
      candidateSha,
      baseSha,
      targetRef: input.publication.targetRef ?? null,
      remoteSha: String(input.publication.remoteSha),
      partial,
      metadata: input.item.metadata ?? null,
    },
  };

  try {
    return await input.storage.transaction(async (tx) => {
      // WHY the item is read FIRST: readItem is what the adapter locks, so the replay lookup, the completion
      // and the append all happen inside the item's lock. Reading prior records before taking it let two
      // concurrent calls both see no record and both append (Root's probe 3).
      const current = await tx.readItem(input.item.itemKey);
      if (current === null)
        throw new Rollback(
          refuse('ITEM_MISSING', `item ${input.item.itemKey} is not readable`, partial),
        );
      const freshStatus = (current.status ?? '').trim().toLowerCase();
      if (freshStatus === 'canceled' || freshStatus === 'cancelled')
        throw new Rollback(
          refuse('ITEM_CANCELED', `item ${input.item.itemKey} is canceled under the lock`, partial),
        );
      if (current.archived === true || freshStatus === 'archived')
        throw new Rollback(
          refuse('ITEM_ARCHIVED', `item ${input.item.itemKey} is archived under the lock`, partial),
        );
      if (current.projectId !== input.item.projectId)
        throw new Rollback(
          refuse(
            'COLUMN_WRONG_PROJECT',
            `item ${input.item.itemKey} is in project ${current.projectId} under the lock, not ${input.item.projectId}`,
            partial,
          ),
        );

      // WHY the replay lookup lives under the lock: an identical second call must SEE the first record, and
      // it can only see it if it is serialised behind the same item lock.
      const prior = await tx.readActivities(input.item.itemKey);
      const mine = prior.filter(
        (entry) => entry.kind !== 'landing_cleanup' && entry.payload?.candidateSha === candidateSha,
      );
      if (mine.length > 0) {
        if (mine.length === 1 && sameRecord(mine[0], row)) {
          return {
            recorded: true,
            completed: !partial,
            replayed: true,
            partial,
            reason: `landing ${candidateSha} was already recorded; nothing was written again`,
            activityId,
          } satisfies RecordResult;
        }
        throw new Rollback(
          refuse(
            'RECORD_CONFLICT',
            `${mine.length} prior record(s) for ${candidateSha} do not match this landing`,
            partial,
          ),
        );
      }
      if (!partial) {
        // WHY the move before the append: a CAS that fails must leave no record behind, and the storage's
        // rollback covers the append only because the append comes after it.
        const moved = await tx.moveItem(
          input.item.itemKey,
          current.columnId,
          input.completedColumnId,
        );
        if (!moved)
          throw new Rollback(
            refuse(
              'MOVE_FAILED',
              `item ${input.item.itemKey} moved away from column ${String(current.columnId)} before completion`,
              partial,
            ),
          );
        await tx.appendActivity(row);
        await tx.recordCleanupObligation({
          itemKey: input.item.itemKey,
          candidateSha,
          kind: 'landing_cleanup',
          obligation: `release the landing lane for ${input.item.itemKey} after ${candidateSha}`,
        });
        return {
          recorded: true,
          completed: true,
          replayed: false,
          partial: false,
          reason: `landing ${candidateSha} recorded; item ${input.item.itemKey} completed into column ${input.completedColumnId}`,
          activityId,
        } satisfies RecordResult;
      }
      // A partial landing records itself and nothing else: the original column is preserved by not moving.
      await tx.appendActivity(row);
      return {
        recorded: true,
        completed: false,
        replayed: false,
        partial: true,
        reason: `partial landing ${candidateSha} recorded; item ${input.item.itemKey} keeps its column`,
        activityId,
      } satisfies RecordResult;
    });
  } catch (error) {
    if (error instanceof Rollback) return error.result;
    // WHY a typed failure and not a throw: the storage rolled back, so the honest report is "nothing
    // landed", and the caller must see that as a result rather than as an exception it might swallow.
    return refuse(
      'STORAGE_FAILED',
      `the record transaction failed and was rolled back: ${String(error)}`,
      partial,
    );
  }
}
