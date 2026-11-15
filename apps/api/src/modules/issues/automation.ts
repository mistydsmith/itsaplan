import { type DbExecutor, db, issue, projectColumn } from '@repo/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getSubtaskAutomationSettings } from '#modules/projects/service';
import { listSubtasks } from './subtasks';
import { updateIssue, type IssueRow } from './service';
import type { ActivityActor } from './activity';

// The subtask automations a column change triggers, both off unless the project
// turns them on (modules/projects/service.ts). A closed issue is one sitting in a
// column whose stateType is 'completed' or 'canceled'.
//
// An issue in the middle of the hierarchy is both a subtask and a parent, so both
// rules apply to it. Each rule writes through updateIssue, so the moved issues get
// their own activity entries and webhooks — and re-enter this function, which
// carries a close up and down the hierarchy one level at a time. That does not
// loop: a rule skips an issue already closed, which is where the nested pass finds
// every issue it would move.

const CLOSED_STATE_TYPES = ['completed', 'canceled'];

// WHY the executor parameter (sentinel-prod-8429 M): a caller that already holds a transaction must drive its
// automation on that same session. Reading the board on the pool and writing through a nested updateIssue on
// the pool would judge stale rows, and letting the nested call open a SECOND transaction would deadlock on the
// rig row this one holds. Default keeps every existing caller exactly as it was.
export async function applySubtaskAutomation(
  after: IssueRow,
  actorUserId?: ActivityActor,
  executor: DbExecutor = db,
): Promise<void> {
  const settings = await getSubtaskAutomationSettings(after.projectId, executor);
  if (!settings.completeParent && !settings.closeSubtasks) return;
  if (!(await isClosedColumn(after.columnId, executor))) return;

  if (settings.closeSubtasks) await closeSubtasks(after, executor, actorUserId);
  if (after.parentId !== null && settings.completeParent)
    await completeParent(after.parentId, after, executor, actorUserId);
}

// Moves the issue's parent into the column the issue was just closed in, once every
// other subtask is closed too. Archived subtasks are off the board and do not hold
// the parent open; an archived parent is left where it is rather than brought back.
// A parent already closed keeps its own column: the rule has nothing left to do.
async function completeParent(
  parentId: number,
  subtask: IssueRow,
  executor: DbExecutor,
  actorUserId?: ActivityActor,
): Promise<void> {
  const siblingColumnIds = (await listSubtasks(parentId, executor))
    .filter((s) => !s.archived && s.id !== subtask.id)
    .map((s) => s.columnId);
  const parentColumnId = await activeColumn(parentId, executor);
  if (parentColumnId === null) return;
  const closed = await closedColumnIds([...siblingColumnIds, parentColumnId], executor);
  if (closed.has(parentColumnId)) return;
  if (siblingColumnIds.some((id) => !closed.has(id))) return;
  await updateIssue(parentId, { columnId: subtask.columnId }, actorUserId, {
    skipIfColumnFull: true,
    executor,
  });
}

// Moves the issue's still-open subtasks into the column it was just closed in.
async function closeSubtasks(
  parent: IssueRow,
  executor: DbExecutor,
  actorUserId?: ActivityActor,
): Promise<void> {
  const subtasks = (await listSubtasks(parent.id, executor)).filter((s) => !s.archived);
  const closed = await closedColumnIds(
    subtasks.map((s) => s.columnId),
    executor,
  );
  for (const subtask of subtasks)
    if (!closed.has(subtask.columnId))
      await updateIssue(subtask.id, { columnId: parent.columnId }, actorUserId, {
        skipIfColumnFull: true,
        executor,
      });
}

async function isClosedColumn(columnId: number, executor: DbExecutor = db): Promise<boolean> {
  return (await closedColumnIds([columnId], executor)).has(columnId);
}

// The subset of the given column ids whose stateType counts as closed.
async function closedColumnIds(
  columnIds: number[],
  executor: DbExecutor = db,
): Promise<Set<number>> {
  const ids = [...new Set(columnIds)];
  if (ids.length === 0) return new Set();
  const rows = await executor
    .select({ id: projectColumn.id })
    .from(projectColumn)
    .where(
      and(inArray(projectColumn.id, ids), inArray(projectColumn.stateType, CLOSED_STATE_TYPES)),
    );
  return new Set(rows.map((r) => r.id));
}

// The issue's column, or null when it is gone or archived.
async function activeColumn(issueId: number, executor: DbExecutor = db): Promise<number | null> {
  const [row] = await executor
    .select({ columnId: issue.columnId })
    .from(issue)
    .where(and(eq(issue.id, issueId), isNull(issue.archivedAt)));
  return row?.columnId ?? null;
}
