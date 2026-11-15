// The local issue create + import_record mapping, with the source-specific
// in-transaction stamp seam (Root P0 2026-11-15 module-guard repair): moved
// whole from import-store.ts so the store monolith does not grow; the body,
// the dedup/sequence/lock behavior and the stamp contract are byte-identical.
import { db, issue, project, lockIssueTree, parentLinkProblem } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';
import {
  notMappedByJob,
  sourceTimestamp,
  upsertImportRecordWith,
  type NewLocalIssue,
} from './import-store';

// The transaction half of the executor, on its own: the source-specific stamp
// hook runs INSIDE createLocalIssueAndRecord's own db.transaction and takes
// exactly that transaction (IdentityTransaction in the db package is the same
// shape) - the wider executor type rejected the hook's parameter and the
// caller's transaction (Root bound-tsc, 2026-11-15).
type ImportDbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// An issue whose title matches one already in the project (case- and
// whitespace-insensitive, the same comparison the file-based importer uses), and
// that this job has not already mapped to another source issue, is reused
// instead of duplicated — the same protection createLocalLabel and
// createLocalStateAndRecord give their own entities. Comments and labels the
// import attaches afterward land on that existing issue rather than being
// orphaned. Skipped for a blank title: input.title falls back to
// '(untitled)' below, and matching on that fallback would merge every
// untitled Plane issue into whichever one happened to import first, which is
// not a duplicate in any real sense.
//
// Sequence numbers ("MKT-42") are issued under a row lock on project, the
// same pattern apps/api's createIssue uses, so a bulk import never collides
// with a concurrent interactive create. The import_record mapping is written
// in the same transaction as the insert: an issue has no unique constraint a
// retry could fall back on (a fresh sequence number is issued every time),
// so a crash between the insert and the mapping would otherwise duplicate
// the issue on the next attempt. sourceDisplayId (the source's own issue
// number) is stashed on that same mapping either way, for the Rewrite phase.
export async function createLocalIssueAndRecord(
  jobId: number,
  sourceId: string,
  sourceDisplayId: string,
  input: NewLocalIssue,
  // An optional source-specific stamp, run inside this function's own transaction after
  // the row and its import_record mapping are written, so it commits or rolls back with
  // them (Root, 8363.1 pipeline decision, 2026-11-15: the hook is invoked by the
  // existing Create phase INSIDE the same import TX, no after-commit stamp; this is
  // the one bounded place the pipeline exposes the tx, and only for a hook the source
  // defined). A source without a stamp passes nothing and the row lands as before.
  stamp?: (tx: ImportDbTransaction, localId: number) => Promise<void>,
): Promise<number> {
  return db.transaction(async (tx) => {
    if (input.title.trim()) {
      const [existing] = await tx
        .select({ id: issue.id })
        .from(issue)
        .where(
          and(
            eq(issue.projectId, input.projectId),
            sql`lower(btrim(${issue.title})) = lower(btrim(${input.title}))`,
            notMappedByJob(jobId, 'issue', issue.id),
          ),
        )
        .orderBy(issue.id)
        .limit(1);
      if (existing) {
        await upsertImportRecordWith(
          tx,
          jobId,
          'issue',
          sourceId,
          'issue',
          existing.id,
          sourceDisplayId,
        );
        if (stamp) await stamp(tx, existing.id);
        return existing.id;
      }
    }
    if (input.parentId !== null) await lockIssueTree(tx, input.projectId);
    const [seqRow] = await tx
      .update(project)
      .set({ nextSequence: sql`next_sequence + 1` })
      .where(eq(project.id, input.projectId))
      .returning({ seq: sql<number>`next_sequence - 1` });
    const [posRow] = await tx
      .select({ pos: sql<number>`COALESCE(MAX(${issue.position}), 0) + 1000` })
      .from(issue)
      .where(eq(issue.columnId, input.columnId));
    const parentId =
      input.parentId !== null && !(await parentLinkProblem(null, input.parentId, tx))
        ? input.parentId
        : null;
    const [row] = await tx
      .insert(issue)
      .values({
        projectId: input.projectId,
        sequenceNumber: Number(seqRow!.seq),
        columnId: input.columnId,
        typeId: input.typeId ?? null,
        initiativeId: input.initiativeId ?? null,
        cycleId: input.cycleId,
        parentId,
        assigneeUserId: input.assigneeUserId,
        title: input.title || '(untitled)',
        description: input.description,
        priority: input.priority,
        startDate: input.startDate,
        dueDate: input.dueDate,
        estimatePoints: input.estimatePoints == null ? null : String(input.estimatePoints),
        estimateMinutes: input.estimateMinutes ?? null,
        position: Number(posRow!.pos),
        createdAt: sourceTimestamp(input.createdAt),
        updatedAt: sourceTimestamp(input.updatedAt),
        archivedAt: input.archivedAt ? (sourceTimestamp(input.archivedAt) ?? new Date()) : null,
      })
      .returning({ id: issue.id });
    await upsertImportRecordWith(tx, jobId, 'issue', sourceId, 'issue', row!.id, sourceDisplayId);
    if (stamp) await stamp(tx, row!.id);
    return row!.id;
  });
}
