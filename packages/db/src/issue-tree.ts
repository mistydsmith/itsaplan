import { sql } from 'drizzle-orm';
import { db, type DbExecutor } from './client';

// An issue with no parent is on level 1.
export const MAX_SUBTASK_DEPTH = 8;

const ISSUE_TREE_LOCK_NAMESPACE = 1_145_390_933;

// Serializes the parent links written in a project. The check runs before the write,
// so two concurrent writes would each pass it and together close a cycle (A under B,
// B under A) or go past the depth limit. Held until the caller's transaction ends.
export async function lockIssueTree(executor: DbExecutor, projectId: number): Promise<void> {
  await executor.execute(
    sql`select pg_advisory_xact_lock(${ISSUE_TREE_LOCK_NAMESPACE}, ${projectId})`,
  );
}

// The recursive parts walk with UNION, which drops a row already seen, so a parent
// cycle in old data ends the walk instead of looping. The level counter in
// parentLinkProblem stops it one past the limit for the same reason.
//
// ancestorIds and subtreeIds stay inside one project: a parent link an old import
// wrote across projects is not followed, so a caller authorised for one project
// never reaches the issues of another.

// The issues above the issue, from the one on level 1 down to its parent. Empty for
// an issue with no parent.
export async function ancestorIds(issueId: number, executor: DbExecutor = db): Promise<number[]> {
  const rows = (await executor.execute(sql`
    WITH RECURSIVE up(id, parent_id, project_id) AS (
      SELECT id, parent_id, project_id FROM issue WHERE id = ${issueId}
      UNION
      SELECT i.id, i.parent_id, i.project_id FROM issue i
        JOIN up ON i.id = up.parent_id AND i.project_id = up.project_id
    )
    SELECT id, parent_id FROM up
  `)) as unknown as { id: number; parent_id: number | null }[];
  const parentOf = new Map(rows.map((row) => [row.id, row.parent_id]));
  const ids: number[] = [];
  for (let id = parentOf.get(issueId); id != null; id = parentOf.get(id)) {
    if (id === issueId || ids.includes(id) || !parentOf.has(id)) break;
    ids.push(id);
  }
  return ids.reverse();
}

// The issues and every issue under them, archived ones included.
export async function subtreeIds(issueIds: number[], executor: DbExecutor = db): Promise<number[]> {
  if (issueIds.length === 0) return [];
  const rows = (await executor.execute(sql`
    WITH RECURSIVE down(id, project_id) AS (
      SELECT id, project_id FROM issue WHERE id IN (${sql.join(
        issueIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      UNION
      SELECT i.id, i.project_id FROM issue i
        JOIN down ON i.parent_id = down.id AND i.project_id = down.project_id
    )
    SELECT id FROM down
  `)) as unknown as { id: number }[];
  return rows.map((row) => row.id);
}

// Why issueId cannot go under parentId, or null when it can.
//
// 'cycle' means the parent is the issue itself, one of its subtasks at any level, or the
// parent chain already loops in stored data. 'depth' is the ordinary project limit being
// passed. 'missing-parent' and 'cross-project' are the association problems, which the
// caller turns into the 400 it already answers with.
//
// A gated project, one whose project row carries a rig_id, has no depth cap at all:
// SPEC_R2 rejects any arbitrary cap for those projects, so the only limits there are the
// cycle rules. That decision is read from the database through the supplied executor, never
// from a caller-supplied flag, because a flag would be authority a request could fake.
//
// expectedProjectId is for a fresh create, where issueId is null and the project cannot be
// read from the issue row. It is the project the caller has already locked, so the
// association is revalidated against it under the lock instead of being trusted.
export interface ParentLinkOptions {
  expectedProjectId?: number;
}

export type ParentLinkProblem = 'cycle' | 'depth' | 'missing-parent' | 'cross-project' | null;

export async function parentLinkProblem(
  issueId: number | null,
  parentId: number,
  executor: DbExecutor = db,
  options: ParentLinkOptions = {},
): Promise<ParentLinkProblem> {
  if (issueId === parentId) return 'cycle';

  const parentRows = (await executor.execute(
    sql`SELECT id, project_id FROM issue WHERE id = ${parentId}`,
  )) as unknown as { id: number; project_id: number }[];
  const parent = parentRows[0];
  if (!parent) return 'missing-parent';

  // For an existing issue the row owns the association, so a supplied project is only a claim
  // about it and a disagreement refuses. The expected project decides the project only for a
  // fresh create, where there is no issue row yet.
  let projectId: number | null = null;
  if (issueId !== null) {
    const ownRows = (await executor.execute(
      sql`SELECT project_id FROM issue WHERE id = ${issueId}`,
    )) as unknown as { project_id: number }[];
    const actual = ownRows[0]?.project_id ?? null;
    if (options.expectedProjectId !== undefined && Number(options.expectedProjectId) !== actual) {
      return 'cross-project';
    }
    projectId = actual;
  } else if (options.expectedProjectId !== undefined) {
    projectId = options.expectedProjectId;
  }
  if (projectId === null) projectId = Number(parent.project_id);
  if (Number(parent.project_id) !== projectId) return 'cross-project';

  const rigRows = (await executor.execute(
    sql`SELECT rig_id FROM project WHERE id = ${projectId}`,
  )) as unknown as { rig_id: number | null }[];
  const gated = rigRows[0]?.rig_id != null;

  if (gated) {
    // The walk is a finite UNION, so stored data that already loops ends it instead of
    // running forever, and the loop is then detected in memory. No level cap is applied:
    // a gated chain of any length is allowed, archived parents included, because nothing
    // here filters on archived_at.
    const rows = (await executor.execute(sql`
      WITH RECURSIVE up(id, parent_id, project_id) AS (
        SELECT id, parent_id, project_id FROM issue WHERE id = ${parentId}
        UNION
        SELECT i.id, i.parent_id, i.project_id FROM issue i JOIN up ON i.id = up.parent_id
      )
      SELECT id, parent_id, project_id FROM up
    `)) as unknown as { id: number; parent_id: number | null; project_id: number }[];
    const parentOf = new Map(rows.map((row) => [row.id, row.parent_id]));
    const projectOf = new Map(rows.map((row) => [row.id, Number(row.project_id)]));
    const seen = new Set<number>();
    for (
      let cursor: number | null = parentId;
      cursor !== null;
      cursor = parentOf.get(cursor) ?? null
    ) {
      if (seen.has(cursor)) return 'cycle';
      seen.add(cursor);
      // A chain that leaves the project is refused wherever it appears, archived imports
      // included, because a caller authorised for one project must not reach another's.
      if (projectOf.get(cursor) !== projectId) return 'cross-project';
      if (issueId !== null && cursor === issueId) return 'cycle';
    }
    return null;
  }

  // An ordinary project keeps the walk and the cap it had, unchanged in both shape and
  // answer, so its errors and its eight-level limit stay exactly as they are.
  const rows = (await executor.execute(sql`
    WITH RECURSIVE up(id, parent_id) AS (
      SELECT id, parent_id FROM issue WHERE id = ${parentId}
      UNION
      SELECT i.id, i.parent_id FROM issue i JOIN up ON i.id = up.parent_id
    ),
    down(id, level) AS (
      SELECT id, 1 FROM issue WHERE id = ${issueId}::int
      UNION ALL
      SELECT i.id, down.level + 1 FROM issue i JOIN down ON i.parent_id = down.id
       WHERE down.level <= ${MAX_SUBTASK_DEPTH}
    )
    SELECT
      EXISTS (SELECT 1 FROM up WHERE id = ${issueId}::int) AS cycle,
      (SELECT count(*) FROM up)::int + (SELECT coalesce(max(level), 1) FROM down)::int AS levels
  `)) as unknown as { cycle: boolean; levels: number }[];
  const row = rows[0];
  if (row?.cycle) return 'cycle';
  if ((row?.levels ?? 0) > MAX_SUBTASK_DEPTH) return 'depth';
  return null;
}
