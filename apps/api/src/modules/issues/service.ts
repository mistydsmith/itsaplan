import {
  db,
  project as projectTable,
  issue,
  issueStatus,
  issueLabel,
  label,
  projectColumn,
  issueType,
  issueFieldValue,
  issueFieldOption,
  issueAttachment,
  issueKeyAlias,
  issueWorklog,
  customField,
  customFieldOption,
  initiative,
  cycle,
  team,
  issueLink,
  MAX_SUBTASK_DEPTH,
  lockIssueTree,
  parentLinkProblem,
  type DbExecutor,
} from '@repo/db';
import {
  allocateBeadToken,
  attachBeadIdentity,
  type AllocationMode,
  type BeadAllocation,
  type IdentityTransaction,
} from '@repo/db/issue-identity';
import {
  gateIssueWrite,
  isTrackerGateRefusal,
  type TrackerGateRefusal,
} from '@repo/db/tracker-gate';
import { isIdFactsRefusal, snapshotIdFacts } from '@repo/db/tracker-issue-facts';
import { alias } from 'drizzle-orm/pg-core';
import {
  and,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import type { IssueQuery } from '#modules/agents/core/issue-query';
import { iso, num, numOrNull, shareLive, HttpError } from '#shared/lib';
import type { ProjectRow } from '#modules/projects/service';
import { projectRefSql } from '#modules/teams/ref';
import { assertProjectFeature } from '#shared/access';
import {
  getCustomFieldById,
  type CustomFieldRow,
  type CustomFieldType,
  type MemberScope,
} from '#modules/custom-fields/service';
import {
  recordActivity,
  recordActivityEntries,
  logIssueUpdate,
  labelNames,
  actorId,
  type ActivityActor,
  userName,
  rowSide,
  type ActivityInput,
  type IssueSnapshot,
} from './activity';
import { stampIssueAnchors } from './anchor-stamp';
import { skillFactsFor } from './skill-facts';
import {
  attachCloseFacts,
  clearOperatorCloseClaim,
  closeBackstopApplies,
  closeOpStart,
  closerOf,
  isBareClose,
  releaseClosedClaim,
  type Closer,
  type CloseRequest,
} from './close-facts';
import { routingFactsFor } from './lane-routing';
import { autoWatchIssue } from './watchers';
import { attachLoggedMinutes } from './worklogs';
import { recordCycleChange } from './cycle-history';
import { recordStatusChange } from './status-history';
import { mapAttachment, type AttachmentRow } from '#modules/attachments/service';
import { notifyIssueChange, notifyTextMentions } from '#modules/notifications/service';
import { emitIssueEvent } from './webhook-payload';
import {
  getAssignTriggerAgent,
  getFieldTriggerAgent,
  isProjectAgent,
} from '#modules/agents/core/service';
import { getInitiativeProjectId } from '#modules/initiatives/service';
import { cycleStatus, getCycleRef, type CycleStatus } from '#modules/cycles/service';
import { getMembership } from '#modules/members/service';
import { enqueueAgentRun } from '#modules/agents/core/run-queue';
import { deleteThreadsWhere } from '#modules/agents/core/runtime/memory';
import { queueStatusRuns } from '#modules/agents/schedules/issue-runs';
import { applySubtaskAutomation } from './automation';
import { assertWipLimit, columnAutoAssignee, wipLimitBreach } from '#modules/columns/service';

// Data access for issues and their per-issue data: labels, custom field values,
// and selected options. The human identifier (e.g. "MKT-42") is the project key
// plus the issue's project-scoped sequence number.

// Compact custom field value for the work items payload: the scalar value (null for
// select/multi_select and unset fields), the end of a datetime_range, and the
// selected option ids.
export interface IssueFieldValueEntry {
  fieldId: number;
  value: string | number | boolean | null;
  valueEnd: string | null;
  optionIds: number[];
}

export interface IssueRow {
  id: number;
  projectId: number;
  // Project-scoped sequence number (the "42" in "MKT-42"). Used to address the
  // issue by its human number in URLs (/acme/issue/MKT-42).
  sequenceNumber: number;
  identifier: string;
  // The bead id stored on the issue in a project with a rig, or null. It is read from the row
  // and never parsed from the title.
  beadId: string | null;
  typeId: number | null;
  // The initiative this issue is linked to, expanded to id + title for rendering
  // and status for ordering the lanes of a board grouped by initiative, or null.
  // Filled by attachGroupings; mapIssue alone leaves it null.
  initiative: { id: number; title: string; status: string } | null;
  // The cycle this issue is planned into, expanded to id + name for rendering and
  // status for filtering by the running or the upcoming ones, or null. Filled by
  // attachGroupings; mapIssue alone leaves it null.
  cycle: { id: number; name: string; status: CycleStatus } | null;
  assigneeUserId: string | null;
  delegateUserId: string | null;
  columnId: number;
  // The issue this one is a subtask of, or null when it stands on its own.
  parentId: number | null;
  title: string;
  description: string;
  priority: string | null;
  // Time is in minutes; the UI enters and shows it as hours and minutes.
  estimatePoints: number | null;
  estimateMinutes: number | null;
  // The time logged against the issue: the sum of its worklog entries, 0 when
  // nothing was logged. Carried here so a board reads it without a request per
  // issue. Populated by attachLoggedMinutes; mapIssue alone leaves it at 0.
  loggedMinutes: number;
  startDate: string | null;
  dueDate: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  // When the issue was archived (hidden from the board but kept), or null when it
  // is active. Set by the archive action or the worker's auto-archive sweep.
  archivedAt: string | null;
  // When the issue entered its current column: the newest status-change activity,
  // or createdAt when it has never changed column. Lets the board show how long an
  // issue has sat in its current state. Populated by listIssues/getIssue; mapIssue
  // alone leaves it at createdAt.
  statusSince: string;
  // Unguessable token for the public read-only share link, or null when the issue
  // is not shared. Populated by mapIssue from the row.
  shareToken: string | null;
  // Whether that link exposes the issue in full (assignees, labels, custom fields,
  // activity) or only its title, description, state, type, priority, dates,
  // subtasks and links.
  shareExtended: boolean;
  // When the share link stops working, or null when it never does. A link past
  // its expiry reads as not shared (shareToken null) even before the sweep clears it.
  shareExpiresAt: string | null;
  labelIds: number[];
  // Custom field values set on this issue, one entry per field that has a scalar
  // value or selected options (unset fields are omitted). Included so the planner
  // UI can filter by custom fields without a per-issue fetch. Only listIssues
  // populates this; mapIssue alone leaves it empty.
  fieldValues: IssueFieldValueEntry[];
}

function mapIssue(row: typeof issue.$inferSelect, projectKey: string): IssueRow {
  const shared = row.shareToken !== null && shareLive(row.shareExpiresAt);
  return {
    id: row.id,
    projectId: row.projectId,
    sequenceNumber: row.sequenceNumber,
    identifier: `${projectKey}-${row.sequenceNumber}`,
    beadId: row.beadId,
    typeId: row.typeId,
    initiative: null,
    cycle: null,
    assigneeUserId: row.assigneeUserId,
    delegateUserId: row.delegateUserId,
    columnId: row.columnId,
    parentId: row.parentId,
    title: row.title,
    description: row.description,
    priority: row.priority,
    estimatePoints: numOrNull(row.estimatePoints),
    estimateMinutes: row.estimateMinutes,
    loggedMinutes: 0,
    startDate: row.startDate,
    dueDate: row.dueDate,
    position: num(row.position),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: row.archivedAt ? iso(row.archivedAt) : null,
    statusSince: iso(row.createdAt),
    shareToken: shared ? row.shareToken : null,
    shareExtended: shared && row.shareExtended,
    shareExpiresAt: shared && row.shareExpiresAt ? iso(row.shareExpiresAt) : null,
    labelIds: [],
    fieldValues: [],
  };
}

// Sets each issue's statusSince to when it entered the column it is in now, leaving
// the createdAt default (set by mapIssue) for an issue with no open stretch. One
// query for the whole set. Mutates the passed issues in place.
async function attachStatusSince(
  issues: IssueRow[],
  ids: number[] | SQLWrapper,
  executor: DbExecutor = db,
): Promise<void> {
  if (issues.length === 0) return;
  const rows = await executor
    .select({ issueId: issueStatus.issueId, enteredAt: issueStatus.enteredAt })
    .from(issueStatus)
    .where(and(inArray(issueStatus.issueId, ids), isNull(issueStatus.leftAt)));
  const byIssue = new Map(rows.map((r) => [r.issueId, iso(r.enteredAt)]));
  for (const i of issues) i.statusSince = byIssue.get(i.id) ?? i.statusSince;
}

// The subset of issue columns the change log diffs.
function snapshot(row: IssueRow): IssueSnapshot {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    columnId: row.columnId,
    typeId: row.typeId,
    initiativeId: row.initiative?.id ?? null,
    cycleId: row.cycle?.id ?? null,
    assigneeUserId: row.assigneeUserId,
    delegateUserId: row.delegateUserId,
    priority: row.priority,
    estimatePoints: row.estimatePoints,
    estimateMinutes: row.estimateMinutes,
    startDate: row.startDate,
    dueDate: row.dueDate,
  };
}

export async function listIssues(project: ProjectRow): Promise<IssueRow[]> {
  const rows = await db
    .select()
    .from(issue)
    .where(and(eq(issue.projectId, project.id), isNull(issue.archivedAt)))
    .orderBy(issue.columnId, issue.position);
  const issues = rows.map((row) => mapIssue(row, project.key));
  await attachDetails(issues, { fieldValues: true, ids: projectIssueIds(project.id, false) });
  return issues;
}

// The project's archived issues, newest archived first. The archive view lists
// these so an owner can restore one. Same per-issue enrichment as the board.
export async function listArchivedIssues(project: ProjectRow): Promise<IssueRow[]> {
  const rows = await db
    .select()
    .from(issue)
    .where(and(eq(issue.projectId, project.id), isNotNull(issue.archivedAt)))
    .orderBy(sql`${issue.archivedAt} desc`);
  const issues = rows.map((row) => mapIssue(row, project.key));
  await attachDetails(issues, { fieldValues: true, ids: projectIssueIds(project.id, true) });
  return issues;
}

// A light issue result for search and list: the fields the command palette and the
// agent's search_issues / list_issues tools need to list and open a match. No
// description (which may embed large data URIs) and no field values, so the payload
// stays small.
export interface IssueSearchHit {
  id: number;
  sequenceNumber: number;
  identifier: string;
  title: string;
  columnId: number;
  typeId: number | null;
  initiativeId: number | null;
  cycleId: number | null;
  parentId: number | null;
  parent: { id: number; identifier: string; title: string } | null;
  assigneeUserId: string | null;
  delegateUserId: string | null;
  priority: string | null;
  dueDate: string | null;
  estimatePoints: number | null;
  estimateMinutes: number | null;
  loggedMinutes: number;
  labelIds: number[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  statusSince: string;
  completedAt: string | null;
}

// When an issue entered the completed state it is still in, read the way the
// analytics closings() read it: moves between completed columns are one stretch.
const completedAt = sql<Date | null>`(
  SELECT min(s.entered_at) FROM ${issueStatus} s
   WHERE s.issue_id = ${issue}.id
     AND s.state_type = 'completed'
     AND NOT EXISTS (
           SELECT 1 FROM ${issueStatus} p
            WHERE p.issue_id = s.issue_id
              AND p.state_type IS DISTINCT FROM 'completed'
              AND (p.entered_at, p.id) > (s.entered_at, s.id)))`.mapWith(issueStatus.enteredAt);

// The same values attachStatusSince and attachLoggedMinutes give a full IssueRow.
const statusSince = sql<Date>`coalesce(
  (SELECT s.entered_at FROM ${issueStatus} s WHERE s.issue_id = ${issue}.id AND s.left_at IS NULL),
  ${issue}.created_at)`.mapWith(issueStatus.enteredAt);
const loggedMinutes = sql<number>`(
  SELECT coalesce(sum(w.minutes), 0)::int FROM ${issueWorklog} w WHERE w.issue_id = ${issue}.id)`;
const parentSequenceNumber = sql<number | null>`(
  SELECT p.sequence_number FROM ${issue} p WHERE p.id = ${issue}.parent_id)`;
const parentTitle = sql<string | null>`(
  SELECT p.title FROM ${issue} p WHERE p.id = ${issue}.parent_id)`;

// Escapes LIKE metacharacters so the query is matched literally (Postgres LIKE uses
// '\' as the default escape character).
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// The issue number in a text query: a bare number, or "KEY-42".
function parseIssueNumber(raw: string): { key: string | null; seq: number } | null {
  if (/^\d+$/.test(raw)) return { key: null, seq: Number(raw) };
  const m = raw.match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/);
  return m ? { key: m[1], seq: Number(m[2]) } : null;
}

// Text search: raw matches, case-insensitively, the title, description, scalar custom
// field text values and select/multi_select option labels, or numberMatch.
function textMatch(raw: string, numberMatch: SQL | undefined): SQL {
  const pattern = `%${escapeLike(raw)}%`;
  return or(
    ilike(issue.title, pattern),
    ilike(issue.description, pattern),
    exists(
      db
        .select({ one: sql`1` })
        .from(issueFieldValue)
        .where(
          and(eq(issueFieldValue.issueId, issue.id), ilike(issueFieldValue.valueText, pattern)),
        ),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(issueFieldOption)
        .innerJoin(customFieldOption, eq(customFieldOption.id, issueFieldOption.optionId))
        .where(
          and(eq(issueFieldOption.issueId, issue.id), ilike(customFieldOption.value, pattern)),
        ),
    ),
    numberMatch,
  )!;
}

function hitOrder(numberMatch: SQL | undefined): SQL[] {
  const recent = sql`${issue.updatedAt} desc`;
  return numberMatch ? [sql`case when ${numberMatch} then 0 else 1 end`, recent] : [recent];
}

const hitColumns = {
  id: issue.id,
  sequenceNumber: issue.sequenceNumber,
  typeId: issue.typeId,
  initiativeId: issue.initiativeId,
  cycleId: issue.cycleId,
  parentId: issue.parentId,
  assigneeUserId: issue.assigneeUserId,
  delegateUserId: issue.delegateUserId,
  columnId: issue.columnId,
  title: issue.title,
  priority: issue.priority,
  dueDate: issue.dueDate,
  estimatePoints: issue.estimatePoints,
  estimateMinutes: issue.estimateMinutes,
  loggedMinutes,
  archivedAt: issue.archivedAt,
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  statusSince,
  completedAt,
  parentSequenceNumber,
  parentTitle,
};

type HitRow = Omit<
  IssueSearchHit,
  | 'identifier'
  | 'parent'
  | 'labelIds'
  | 'archived'
  | 'createdAt'
  | 'updatedAt'
  | 'statusSince'
  | 'completedAt'
  | 'estimatePoints'
> & {
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  statusSince: Date;
  completedAt: Date | null;
  parentSequenceNumber: number | null;
  parentTitle: string | null;
  estimatePoints: string | null;
};

function toHit(
  {
    archivedAt,
    createdAt,
    updatedAt,
    statusSince,
    completedAt,
    parentSequenceNumber,
    parentTitle,
    estimatePoints,
    ...r
  }: HitRow,
  projectKey: string,
): IssueSearchHit {
  return {
    ...r,
    identifier: `${projectKey}-${r.sequenceNumber}`,
    // A parent is always in the issue's own project, so it carries the same key.
    parent:
      r.parentId !== null && parentSequenceNumber !== null && parentTitle !== null
        ? {
            id: r.parentId,
            identifier: `${projectKey}-${parentSequenceNumber}`,
            title: parentTitle,
          }
        : null,
    labelIds: [],
    archived: archivedAt !== null,
    createdAt: iso(createdAt),
    updatedAt: iso(updatedAt),
    statusSince: iso(statusSince),
    completedAt: completedAt ? iso(completedAt) : null,
    estimatePoints: numOrNull(estimatePoints),
  };
}

type FieldFilters = Pick<
  IssueQuery,
  'assigneeUserId' | 'delegateUserId' | 'priority' | 'dueFrom' | 'dueTo'
> & {
  createdFrom?: Date;
  createdTo?: Date;
  updatedFrom?: Date;
  updatedTo?: Date;
};

// The exact filters list_issues and the cross-project list share.
function fieldConds(filters: FieldFilters): SQL[] {
  const conds: SQL[] = [];
  if (filters.assigneeUserId !== undefined)
    conds.push(
      filters.assigneeUserId === null
        ? isNull(issue.assigneeUserId)
        : eq(issue.assigneeUserId, filters.assigneeUserId),
    );
  if (filters.delegateUserId !== undefined)
    conds.push(
      filters.delegateUserId === null
        ? isNull(issue.delegateUserId)
        : eq(issue.delegateUserId, filters.delegateUserId),
    );
  if (filters.priority !== undefined)
    conds.push(
      filters.priority === null ? isNull(issue.priority) : eq(issue.priority, filters.priority),
    );
  // A null due date never falls in a range, so gte/lte alone exclude it.
  if (filters.dueFrom !== undefined) conds.push(gte(issue.dueDate, filters.dueFrom));
  if (filters.dueTo !== undefined) conds.push(lte(issue.dueDate, filters.dueTo));
  if (filters.createdFrom) conds.push(gte(issue.createdAt, filters.createdFrom));
  if (filters.createdTo) conds.push(lt(issue.createdAt, filters.createdTo));
  if (filters.updatedFrom) conds.push(gte(issue.updatedAt, filters.updatedFrom));
  if (filters.updatedTo) conds.push(lt(issue.updatedAt, filters.updatedTo));
  return conds;
}

// Server-side issue read backing two routes: text search (search_issues) and the
// filtered list (list_issues). Text search (filters.query) is textMatch, and also
// matches the issue number: a bare number, or "KEY-42" for this project. The other
// fields apply as exact filters (used by list_issues). includeArchived adds archived
// issues to the result (search always sets it; list defaults to active only).
export async function searchIssues(
  project: ProjectRow,
  filters: IssueQuery & {
    createdFrom?: Date;
    createdTo?: Date;
    updatedFrom?: Date;
    updatedTo?: Date;
  },
  opts: { includeArchived?: boolean } = {},
): Promise<IssueSearchHit[]> {
  const conds: SQL[] = [eq(issue.projectId, project.id)];
  if (!opts.includeArchived) conds.push(isNull(issue.archivedAt));

  const raw = filters.query?.trim();
  let numberMatch: SQL | undefined;
  if (raw) {
    const number = parseIssueNumber(raw);
    if (number && (number.key === null || number.key.toLowerCase() === project.key.toLowerCase()))
      numberMatch = eq(issue.sequenceNumber, number.seq);
    conds.push(textMatch(raw, numberMatch));
  }

  // Exact filters, mirroring matchesIssue: undefined skips the filter, null matches
  // rows where the column is null, a value matches equality.
  if (filters.columnId !== undefined) conds.push(eq(issue.columnId, filters.columnId));
  if (filters.typeId !== undefined)
    conds.push(filters.typeId === null ? isNull(issue.typeId) : eq(issue.typeId, filters.typeId));
  if (filters.initiativeId !== undefined)
    conds.push(
      filters.initiativeId === null
        ? isNull(issue.initiativeId)
        : eq(issue.initiativeId, filters.initiativeId),
    );
  if (filters.cycleId !== undefined)
    conds.push(
      filters.cycleId === null ? isNull(issue.cycleId) : eq(issue.cycleId, filters.cycleId),
    );
  if (filters.parentId !== undefined)
    conds.push(
      filters.parentId === null ? isNull(issue.parentId) : eq(issue.parentId, filters.parentId),
    );
  conds.push(...fieldConds(filters));
  // labelIds is AND: the issue must carry every supplied label.
  for (const labelId of filters.labelIds ?? []) {
    conds.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(issueLabel)
          .where(and(eq(issueLabel.issueId, issue.id), eq(issueLabel.labelId, labelId))),
      ),
    );
  }

  if (filters.blocked) {
    const blocker = alias(issue, 'blocker');
    const blockerColumn = alias(projectColumn, 'blocker_column');
    conds.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(issueLink)
          .innerJoin(blocker, eq(blocker.id, issueLink.sourceIssueId))
          .innerJoin(blockerColumn, eq(blockerColumn.id, blocker.columnId))
          .where(
            and(
              eq(issueLink.targetIssueId, issue.id),
              eq(issueLink.kind, 'blocks'),
              isNull(blocker.archivedAt),
              notInArray(blockerColumn.stateType, ['completed', 'canceled']),
            ),
          ),
      ),
    );
  }

  const base = db
    .select(hitColumns)
    .from(issue)
    .where(and(...conds))
    .orderBy(...hitOrder(numberMatch));
  const rows = filters.limit !== undefined ? await base.limit(filters.limit) : await base;

  const hits = rows.map((r) => toHit(r, project.key));
  await attachLabels(hits);
  return hits;
}

export interface CrossProjectIssueHit extends IssueSearchHit {
  projectId: number;
  projectRef: string;
  projectKey: string;
  projectName: string;
  teamName: string;
}

const crossProjectHitColumns = {
  ...hitColumns,
  projectId: projectTable.id,
  projectRef: projectRefSql,
  projectKey: projectTable.key,
  projectName: projectTable.name,
  teamName: team.name,
};

function toCrossProjectHit({
  projectId,
  projectRef,
  projectKey,
  projectName,
  teamName,
  ...r
}: HitRow & Omit<CrossProjectIssueHit, keyof IssueSearchHit>): CrossProjectIssueHit {
  return { ...toHit(r, projectKey), projectId, projectRef, projectKey, projectName, teamName };
}

// Text search across the given projects, archived issues included, at most
// perProjectLimit hits from each project. "KEY-42" matches issue 42 of every listed
// project whose key is KEY, since a key is unique only within its team.
export async function searchIssuesInProjects(
  projectIds: number[],
  query: string,
  { limit, perProjectLimit }: { limit: number; perProjectLimit: number },
): Promise<CrossProjectIssueHit[]> {
  const raw = query.trim();
  if (!projectIds.length || !raw) return [];
  const number = parseIssueNumber(raw);
  const numberMatch = number
    ? and(
        eq(issue.sequenceNumber, number.seq),
        number.key === null
          ? undefined
          : sql`lower(${projectTable.key}) = ${number.key.toLowerCase()}`,
      )
    : undefined;
  const order = hitOrder(numberMatch);
  // Only the id and the rank: the window sees every match, the hit columns are read
  // for the rows that pass the cap.
  const ranked = db
    .select({
      id: issue.id,
      rank: sql<number>`row_number() over (partition by ${issue.projectId} order by ${sql.join(order, sql`, `)})`.as(
        'rank',
      ),
    })
    .from(issue)
    .innerJoin(projectTable, eq(projectTable.id, issue.projectId))
    .where(and(inArray(issue.projectId, projectIds), textMatch(raw, numberMatch)))
    .as('ranked');
  const rows = await db
    .select(crossProjectHitColumns)
    .from(issue)
    .innerJoin(ranked, eq(ranked.id, issue.id))
    .innerJoin(projectTable, eq(projectTable.id, issue.projectId))
    .innerJoin(team, eq(team.id, projectTable.teamId))
    .where(lte(ranked.rank, perProjectLimit))
    .orderBy(...order)
    .limit(limit);
  const hits = rows.map(toCrossProjectHit);
  await attachLabels(hits);
  return hits;
}

export const ISSUE_STATE_TYPES = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const;
export type IssueStateType = (typeof ISSUE_STATE_TYPES)[number];

// The filtered list over the given projects, most recently updated first. The ids it
// takes (cycles, parents) are global, so they need no project to resolve against.
export async function listIssuesInProjects(
  projectIds: number[],
  filters: FieldFilters & {
    cycleIds?: number[];
    parentIds?: number[];
    stateTypes?: IssueStateType[];
    limit: number;
  },
  opts: { includeArchived?: boolean } = {},
): Promise<CrossProjectIssueHit[]> {
  if (!projectIds.length) return [];
  const conds: SQL[] = [inArray(issue.projectId, projectIds), ...fieldConds(filters)];
  if (!opts.includeArchived) conds.push(isNull(issue.archivedAt));
  if (filters.cycleIds) conds.push(inArray(issue.cycleId, filters.cycleIds));
  if (filters.parentIds) conds.push(inArray(issue.parentId, filters.parentIds));
  if (filters.stateTypes)
    conds.push(
      inArray(
        issue.columnId,
        db
          .select({ id: projectColumn.id })
          .from(projectColumn)
          .where(inArray(projectColumn.stateType, filters.stateTypes)),
      ),
    );
  const rows = await db
    .select(crossProjectHitColumns)
    .from(issue)
    .innerJoin(projectTable, eq(projectTable.id, issue.projectId))
    .innerJoin(team, eq(team.id, projectTable.teamId))
    .where(and(...conds))
    .orderBy(...hitOrder(undefined))
    .limit(filters.limit);
  const hits = rows.map(toCrossProjectHit);
  await attachLabels(hits);
  return hits;
}

// Archives an issue: sets archived_at so it drops off the board and lists, keeping
// the row for restore. Idempotent (archiving an archived issue is a no-op re-stamp
// avoided by the archived_at guard). Records a feed entry. Returns the updated
// issue, or null if it does not exist. Archiving is reversible, so nothing the issue
// carries is dropped — the agents' conversation threads included.
export async function archiveIssue(
  id: number,
  actorUserId?: string | null,
): Promise<IssueRow | null> {
  const [row] = await db
    .update(issue)
    .set({ archivedAt: sql`now()` })
    .where(and(eq(issue.id, id), isNull(issue.archivedAt)))
    .returning({ id: issue.id });
  if (!row) {
    // Either not found, or already archived. Distinguish so a missing issue 404s.
    return getIssue(id);
  }
  await recordActivity(id, [{ action: 'archived' }], actorUserId);
  const archived = await getIssue(id);
  if (archived) await emitIssueEvent('issue.updated', archived, actorUserId);
  return archived;
}

// Restores an archived issue back onto the board (archived_at -> null). Records a
// feed entry. Returns the updated issue, or null if it does not exist.
export async function restoreIssue(
  id: number,
  actorUserId?: string | null,
): Promise<IssueRow | null> {
  const [row] = await db
    .update(issue)
    .set({ archivedAt: null })
    .where(and(eq(issue.id, id), isNotNull(issue.archivedAt)))
    .returning({ id: issue.id });
  if (!row) return getIssue(id);
  await recordActivity(id, [{ action: 'restored' }], actorUserId);
  const restored = await getIssue(id);
  if (restored) await emitIssueEvent('issue.updated', restored, actorUserId);
  return restored;
}

// Expands what an issue is planned under — its initiative and its cycle — to
// { id, title, status } / { id, name, status } in place. Both hang off the same issue rows, so one
// query carries them; an issue linked to neither keeps the nulls mapIssue set.
// Rendering those names on a board card needs no separate scaffold lookup this way.
async function attachGroupings(
  issues: IssueRow[],
  ids: number[] | SQLWrapper,
  executor: DbExecutor = db,
): Promise<void> {
  if (issues.length === 0) return;
  const rows = await executor
    .select({
      issueId: issue.id,
      initiativeId: initiative.id,
      initiativeTitle: initiative.title,
      initiativeStatus: initiative.status,
      cycleId: cycle.id,
      cycleName: cycle.name,
      cycleStart: cycle.startDate,
      cycleEnd: cycle.endDate,
      cycleCompletedAt: cycle.completedAt,
    })
    .from(issue)
    .leftJoin(initiative, eq(initiative.id, issue.initiativeId))
    .leftJoin(cycle, eq(cycle.id, issue.cycleId))
    .where(
      and(inArray(issue.id, ids), or(isNotNull(issue.initiativeId), isNotNull(issue.cycleId))),
    );
  const byIssue = new Map(rows.map((r) => [r.issueId, r]));
  for (const i of issues) {
    const r = byIssue.get(i.id);
    i.initiative =
      r && r.initiativeId != null
        ? { id: r.initiativeId, title: r.initiativeTitle!, status: r.initiativeStatus! }
        : null;
    i.cycle =
      r && r.cycleId != null
        ? {
            id: r.cycleId,
            name: r.cycleName!,
            status: cycleStatus(r.cycleStart!, r.cycleEnd!, r.cycleCompletedAt),
          }
        : null;
  }
}

// The ids of a project's active or archived issues, as a subquery. A whole board
// selects its rows by it rather than by a parameter per issue.
function projectIssueIds(projectId: number, archived: boolean): SQLWrapper {
  return db
    .select({ id: issue.id })
    .from(issue)
    .where(
      and(
        eq(issue.projectId, projectId),
        archived ? isNotNull(issue.archivedAt) : isNull(issue.archivedAt),
      ),
    );
}

// Fills in what an issue row leaves out: its labels, when it entered its column, its
// initiative and cycle, the time logged on it, and its field values when asked for.
// The reads do not depend on each other, so they run at once. `ids` selects the same
// issues as the list does.
async function attachDetails(
  issues: IssueRow[],
  opts: { fieldValues?: boolean; ids?: SQLWrapper } = {},
  executor: DbExecutor = db,
) {
  const ids = opts.ids ?? issues.map((i) => i.id);
  await Promise.all([
    attachLabels(issues, ids, executor),
    opts.fieldValues ? attachFieldValues(issues, ids, executor) : undefined,
    attachStatusSince(issues, ids, executor),
    attachGroupings(issues, ids, executor),
    attachLoggedMinutes(issues, ids, executor),
  ]);
}

// Loads every issue's label ids and merges them onto the issues in place. Generic
// so it also enriches the lighter IssueSearchHit rows, which carry id + labelIds.
async function attachLabels<T extends { id: number; labelIds: number[] }>(
  issues: T[],
  ids: number[] | SQLWrapper = issues.map((i) => i.id),
  executor: DbExecutor = db,
): Promise<void> {
  if (issues.length === 0) return;
  const rows = await executor
    .select({ issueId: issueLabel.issueId, labelId: issueLabel.labelId })
    .from(issueLabel)
    .where(inArray(issueLabel.issueId, ids));
  const byIssue = new Map<number, number[]>();
  for (const r of rows) {
    let list = byIssue.get(r.issueId);
    if (!list) byIssue.set(r.issueId, (list = []));
    list.push(r.labelId);
  }
  for (const i of issues) i.labelIds = byIssue.get(i.id) ?? [];
}

// Loads every issue's custom field values in two queries (scalar values and
// selected option ids) and merges them onto the issues. A field with no scalar
// value and no options is omitted, so unset fields add nothing to the payload.
// Mutates the passed issues in place.
async function attachFieldValues(
  issues: IssueRow[],
  issueIds: number[] | SQLWrapper,
  executor: DbExecutor = db,
): Promise<void> {
  if (issues.length === 0) return;
  const [scalarRows, optionRows] = await Promise.all([
    executor
      .select({
        issueId: issueFieldValue.issueId,
        fieldId: issueFieldValue.fieldId,
        valueText: issueFieldValue.valueText,
        valueNumber: issueFieldValue.valueNumber,
        valueBool: issueFieldValue.valueBool,
        valueDate: issueFieldValue.valueDate,
        valueDatetime: issueFieldValue.valueDatetime,
        valueDatetimeEnd: issueFieldValue.valueDatetimeEnd,
        valueUserId: issueFieldValue.valueUserId,
      })
      .from(issueFieldValue)
      .where(inArray(issueFieldValue.issueId, issueIds)),
    executor
      .select({
        issueId: issueFieldOption.issueId,
        fieldId: issueFieldOption.fieldId,
        optionId: issueFieldOption.optionId,
      })
      .from(issueFieldOption)
      .where(inArray(issueFieldOption.issueId, issueIds)),
  ]);

  // issueId -> fieldId -> entry, built up from both queries then flushed onto
  // each issue. Keyed maps keep the merge O(rows) rather than O(issues*rows).
  const byIssue = new Map<number, Map<number, IssueFieldValueEntry>>();
  const entryFor = (issueId: number, fieldId: number): IssueFieldValueEntry => {
    let fields = byIssue.get(issueId);
    if (!fields) byIssue.set(issueId, (fields = new Map()));
    let entry = fields.get(fieldId);
    if (!entry)
      fields.set(fieldId, (entry = { fieldId, value: null, valueEnd: null, optionIds: [] }));
    return entry;
  };

  for (const row of scalarRows) {
    const entry = entryFor(row.issueId, row.fieldId);
    entry.value = pickScalarValue(row);
    entry.valueEnd = row.valueDatetimeEnd ? iso(row.valueDatetimeEnd) : null;
  }
  for (const row of optionRows) entryFor(row.issueId, row.fieldId).optionIds.push(row.optionId);

  for (const i of issues) {
    const fields = byIssue.get(i.id);
    if (fields) i.fieldValues = [...fields.values()];
  }
}

// The snapshot columns of an issue, without the label and project-key joins a
// full load does. Used as the "before" state for the change-log diff, which
// needs only these columns, plus the project id the update's scope checks run
// against. A writer that must judge the card on its own locked transaction passes that
// executor; the default client is what the ordinary change-log read uses.
async function loadSnapshot(
  id: number,
  executor: DbExecutor = db,
): Promise<(IssueSnapshot & { projectId: number; parentId: number | null }) | null> {
  const rows = await executor
    .select({
      id: issue.id,
      projectId: issue.projectId,
      parentId: issue.parentId,
      title: issue.title,
      description: issue.description,
      columnId: issue.columnId,
      typeId: issue.typeId,
      initiativeId: issue.initiativeId,
      cycleId: issue.cycleId,
      assigneeUserId: issue.assigneeUserId,
      delegateUserId: issue.delegateUserId,
      priority: issue.priority,
      estimatePoints: issue.estimatePoints,
      estimateMinutes: issue.estimateMinutes,
      startDate: issue.startDate,
      dueDate: issue.dueDate,
    })
    .from(issue)
    .where(eq(issue.id, id));
  const row = rows[0];
  return row ? { ...row, estimatePoints: numOrNull(row.estimatePoints) } : null;
}

export async function getIssue(id: number, executor: DbExecutor = db): Promise<IssueRow | null> {
  return (await getIssues([id], executor))[0] ?? null;
}

// Several issues at once, in no particular order. The per-issue enrichment is
// batched, so this costs what a single getIssue does however many ids it is given
// — which is what makes it worth using for the writes that touch two issues.
export async function getIssues(ids: number[], executor: DbExecutor = db): Promise<IssueRow[]> {
  if (ids.length === 0) return [];
  // WHY the executor reaches the enrichment too: a writer that reads back its own uncommitted
  // issue needs the labels, state stretch, groupings and logged minutes it just wrote, and those
  // are separate queries. On the default client they are invisible until commit, so the DTO would
  // come back looking like an issue with no labels, no status and no time.
  const rows = await executor
    .select({ issue, projectKey: projectTable.key })
    .from(issue)
    .innerJoin(projectTable, eq(projectTable.id, issue.projectId))
    .where(inArray(issue.id, ids));
  const issues = rows.map((row) => mapIssue(row.issue, row.projectKey));
  await attachDetails(issues, {}, executor);
  return issues;
}

// Loads an issue by its project-scoped sequence number (the human number in a URL
// like /acme/issue/MKT-42). Returns null if the project has no issue with that
// number. Archived issues resolve too, so a link to one still opens, and so does the
// number of an issue that moved to another project — the row returned then carries
// its current project and identifier.
export async function getIssueBySequence(
  projectId: number,
  sequenceNumber: number,
): Promise<IssueRow | null> {
  const rows = await db
    .select({ issue, projectKey: projectTable.key })
    .from(issue)
    .innerJoin(projectTable, eq(projectTable.id, issue.projectId))
    .where(
      or(
        and(eq(issue.projectId, projectId), eq(issue.sequenceNumber, sequenceNumber)),
        exists(
          db
            .select({ id: issueKeyAlias.issueId })
            .from(issueKeyAlias)
            .where(
              and(
                eq(issueKeyAlias.issueId, issue.id),
                eq(issueKeyAlias.projectId, projectId),
                eq(issueKeyAlias.sequenceNumber, sequenceNumber),
              ),
            ),
        ),
      ),
    );
  if (!rows[0]) return null;
  const mapped = mapIssue(rows[0].issue, rows[0].projectKey);
  await attachDetails([mapped]);
  return mapped;
}

// The project an issue belongs to, or null if the issue does not exist. Used by
// the access check on routes that address an issue by its own id.
export async function getIssueProjectId(id: number): Promise<number | null> {
  const rows = await db.select({ projectId: issue.projectId }).from(issue).where(eq(issue.id, id));
  return rows[0]?.projectId ?? null;
}

export interface NewIssueInput {
  typeId?: number | null;
  initiativeId?: number | null;
  cycleId?: number | null;
  assigneeUserId?: string | null;
  delegateUserId?: string | null;
  columnId: number;
  parentId?: number | null;
  title: string;
  description?: string;
  priority?: string | null;
  estimatePoints?: number | null;
  estimateMinutes?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  labelIds?: number[];
  // How a gated project mints this issue's bead identity. The route validates the three names; an
  // ordinary project ignores it.
  beadAllocationMode?: AllocationMode;
}

// Enforces that assignee holds a project member and delegate holds an agent of the
// same project. Only checks the fields present in the patch, and only when set to a
// non-null value (clearing a field is always allowed). Throws 400 otherwise.
async function assertAssignments(
  projectId: number,
  patch: { assigneeUserId?: string | null; delegateUserId?: string | null },
  executor: DbExecutor = db,
): Promise<void> {
  if (patch.assigneeUserId) {
    const role = await getMembership(projectId, patch.assigneeUserId, executor);
    if (!role) throw new HttpError(400, 'Assignee must be a project member');
  }
  if (patch.delegateUserId) {
    if (!(await isProjectAgent(projectId, patch.delegateUserId, executor)))
      throw new HttpError(400, 'Delegate must be an agent of this project');
  }
}

// Enforces that a linked initiative belongs to the same project. Only checks when
// set to a non-null value (clearing the link is always allowed). Throws 400
// otherwise.
async function assertInitiative(
  projectId: number,
  initiativeId: number | null | undefined,
  executor: DbExecutor = db,
): Promise<void> {
  if (initiativeId == null) return;
  await assertProjectFeature(projectId, 'initiatives', executor);
  if ((await getInitiativeProjectId(initiativeId, executor)) !== projectId)
    throw new HttpError(400, 'Initiative must belong to this project');
}

// Enforces that a linked cycle belongs to the same project and has not finished: a
// completed cycle is the record of what it delivered, so no issue is planned into it
// after the fact. Only checks when the link changes to a non-null value — clearing
// it, and keeping the cycle an issue is already on, stay allowed. Throws 400
// otherwise.
async function assertCycle(
  projectId: number,
  cycleId: number | null | undefined,
  currentCycleId: number | null = null,
  executor: DbExecutor = db,
): Promise<void> {
  if (cycleId == null || cycleId === currentCycleId) return;
  await assertProjectFeature(projectId, 'cycles', executor);
  const ref = await getCycleRef(cycleId, executor);
  if (!ref || ref.projectId !== projectId)
    throw new HttpError(400, 'Cycle must belong to this project');
  if (ref.status === 'completed') throw new HttpError(400, 'A completed cycle takes no new issues');
}

// Enforces that a column belongs to the issue's project — issue.column_id only
// requires the column to exist somewhere, so an issue could otherwise sit on
// another project's board. Throws 400 otherwise.
async function assertColumn(
  projectId: number,
  columnId: number | undefined,
  executor: DbExecutor = db,
): Promise<void> {
  if (columnId === undefined) return;
  const rows = await executor
    .select({ id: projectColumn.id })
    .from(projectColumn)
    .where(and(eq(projectColumn.id, columnId), eq(projectColumn.projectId, projectId)));
  if (rows.length === 0) throw new HttpError(400, 'Column must belong to this project');
}

// Enforces that an issue type belongs to the issue's project. Only checks when set
// to a non-null value (clearing the type is always allowed). Throws 400 otherwise.
// WHY the trailing executor (sentinel-prod-8429): a type created inside the caller's transaction is invisible to
// the pool, so without it a legal move onto a just-created type is refused. Default keeps create and every other
// caller exactly as they were.
async function assertIssueType(
  projectId: number,
  typeId: number | null | undefined,
  executor: DbExecutor = db,
): Promise<void> {
  if (typeId == null) return;
  const rows = await executor
    .select({ id: issueType.id })
    .from(issueType)
    .where(and(eq(issueType.id, typeId), eq(issueType.projectId, projectId)));
  if (rows.length === 0) throw new HttpError(400, 'Issue type must belong to this project');
}

// Enforces that a parent link stays inside one project and that no issue is its own
// parent. The tree rules are in assertTreeLink. Throws 400 otherwise; clearing the
// parent is always allowed.
async function assertParent(
  projectId: number,
  issueId: number | null,
  parentId: number | null | undefined,
  executor: DbExecutor = db,
): Promise<void> {
  if (parentId == null) return;
  // assertProjectFeature already took an executor (shared/access.ts), so the feature check rides the same session
  // as the parent read below.
  await assertProjectFeature(projectId, 'subtasks', executor);
  if (parentId === issueId) throw new HttpError(400, 'An issue cannot be its own parent');
  const rows = await executor
    .select({ projectId: issue.projectId })
    .from(issue)
    .where(eq(issue.id, parentId));
  if (rows.length === 0 || rows[0].projectId !== projectId)
    throw new HttpError(400, 'Parent must belong to this project');
}

// Rejects a link that puts the issue under one of its own subtasks, or the issue
// with its subtasks past MAX_SUBTASK_DEPTH. issueId is null for an issue being
// created. Throws 400.
// The one door to the tree rules. The caller must already hold the project's board lock
// (lockIssueTree) and must never take it after locking the issue: the order is board lock,
// then issue, never the other way round.
//
// expectedProjectId is for a fresh create, where the issue row does not exist yet and the
// project cannot be read from it. Pass the project the caller has locked, so the parent's
// association is revalidated under that lock rather than trusted from the request.
export async function assertTreeLink(
  issueId: number | null,
  parentId: number | null | undefined,
  executor: DbExecutor = db,
  options: { expectedProjectId?: number } = {},
): Promise<void> {
  if (parentId == null) return;
  const problem = await parentLinkProblem(issueId, parentId, executor, options);
  if (problem === 'cycle')
    throw new HttpError(400, 'An issue cannot become a subtask of its own subtask');
  if (problem === 'depth')
    throw new HttpError(400, `Subtasks can be nested at most ${MAX_SUBTASK_DEPTH} levels deep`);
  // The association answers keep the wording callers already receive from assertParent.
  if (problem === 'missing-parent' || problem === 'cross-project')
    throw new HttpError(400, 'Parent must belong to this project');
}

// Enforces that every label belongs to the issue's project — the issue_label
// foreign key only requires the label to exist somewhere. Throws 400 otherwise.
// WHY the executor: this is a read of the label table, and a writer that created a label
// inside its own transaction has to see that label here. On the default client a label
// inserted in the same transaction does not exist yet, so the check would refuse the
// writer's own label as "not in this project".
async function assertIssueLabels(
  projectId: number,
  labelIds?: number[],
  executor: DbExecutor = db,
): Promise<void> {
  const ids = [...new Set(labelIds ?? [])];
  if (ids.length === 0) return;
  const rows = await executor
    .select({ id: label.id })
    .from(label)
    .where(and(eq(label.projectId, projectId), inArray(label.id, ids)));
  if (rows.length !== ids.length) throw new HttpError(400, 'Labels must belong to this project');
}

// ISO 'YYYY-MM-DD' strings order correctly as plain strings. One date alone, or
// the two equal, is fine.
function assertDateOrder(startDate?: string | null, dueDate?: string | null) {
  if (startDate && dueDate && dueDate < startDate)
    throw new HttpError(400, 'Due date must not precede the start date');
}

// The rig a project is configured with right now. This is only a lock-order hint: it says
// whether to take the rig lock first, and it is never trusted for the write.
async function projectRigHint(executor: DbExecutor, projectId: number): Promise<number | null> {
  const rows = (await executor.execute(
    sql`SELECT rig_id FROM project WHERE id = ${projectId}`,
  )) as unknown as { rig_id: number | string | null }[];
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Project not found');
  return row.rig_id === null ? null : Number(row.rig_id);
}

// Takes the project row's write lock and returns the rig it holds while that lock is held,
// which is the point: another transaction can change the rig before this one writes, and the
// only way to see that is to hold the row until commit. The row is locked after the rig and
// the board on a gated path, never before them.
async function lockProjectRig(executor: DbExecutor, projectId: number): Promise<number | null> {
  const rows = (await executor.execute(
    sql`SELECT rig_id FROM project WHERE id = ${projectId} FOR UPDATE`,
  )) as unknown as { rig_id: number | string | null }[];
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Project not found');
  return row.rig_id === null ? null : Number(row.rig_id);
}

// The ordinary update's one added recheck, under the transaction's own read: a project that
// acquires a rig between the pool read and the write would otherwise pass ungated, so the
// project row is re-read FOR SHARE and a non-null rig is the same 409 retry the gated path
// gives when it loses the race the other way. The parent board lock goes BEFORE that read:
// an ordinary create takes the board lock and then the project row's write lock, so taking
// the project row first here would let a parented update and a parented create on one
// project hold the two locks in opposite orders and deadlock (40P01). Board before project
// everywhere matches create and the gated path, and assertTreeLink stays after both. FOR
// SHARE does not block other ordinary writes, so the board's drag traffic keeps its cost.
// No owner config, read or spawn happens here: an ordinary project stays exactly as fast
// as it was.
async function ordinaryUpdatePrep(
  tx: DbExecutor,
  projectId: number,
  parentId: number | null | undefined,
  id: number,
  set: Partial<typeof issue.$inferInsert>,
): Promise<Partial<typeof issue.$inferInsert>> {
  if (parentId != null) await lockIssueTree(tx, projectId);
  const rows = (await tx.execute(
    sql`SELECT rig_id FROM project WHERE id = ${projectId} FOR SHARE`,
  )) as unknown as { rig_id: number | string | null }[];
  if (rows[0] && rows[0].rig_id != null) {
    throw new HttpError(
      409,
      'This project changed its rig while the issue was being updated; try again',
    );
  }
  if (parentId != null) await assertTreeLink(id, parentId, tx);
  return set;
}

// The gated update's pre-write decision, made on the caller's own locked transaction and
// returned as the set the guarded UPDATE applies — or null when the write must not run at all
// (the issue row vanished under the lock, or a move into a hard-limited column was dropped by
// the caller's skip). The shared lock order is the rig row, then the board, then the project
// row and the issue row, and only under all of them are the facts the owner is judged on read:
// the stored labels, the ledger's bead id and the column states. Body-supplied overrides and
// routing or close facts are never attached: the write the owner sees is the write the locks
// hold, and a refusal rolls the whole transaction back instead of leaving a partial write.
async function gateUpdateWrite(
  tx: DbExecutor,
  input: {
    rigHint: number;
    id: number;
    before: IssueSnapshot & { projectId: number; parentId: number | null };
    patch: IssuePatch;
    set: Partial<typeof issue.$inferInsert>;
    skipIfColumnFull: boolean;
    onlyIfColumnId?: number;
    actorUserId: string | null;
    closeRequest?: CloseRequest;
  },
): Promise<{
  writeSet: Partial<typeof issue.$inferInsert>;
  lockedBefore: IssueSnapshot & { projectId: number; parentId: number | null };
  // The closer whose claim the owner judged, when this write is an allowed close.
  closer: Closer | null;
  // The server-computed operator close fact of the close op, when this write is a close (8429.2).
  operatorClose: boolean;
} | null> {
  const { id, before, patch, set, skipIfColumnFull } = input;
  const rigRows = (await tx.execute(
    sql`SELECT id FROM rig WHERE id = ${input.rigHint} FOR UPDATE`,
  )) as unknown as { id: number | string }[];
  if (rigRows.length === 0) {
    // The rig row the hint named is gone: the project's rig is no longer what the write judged.
    throw new HttpError(
      409,
      'This project changed its rig while the issue was being updated; try again',
    );
  }
  await lockIssueTree(tx, before.projectId);
  const rigId = await lockProjectRig(tx, before.projectId);
  if (rigId !== input.rigHint) {
    throw new HttpError(
      409,
      'This project changed its rig while the issue was being updated; try again',
    );
  }
  // The card itself is locked before the previous state is read, so the previous state is the
  // row the write will actually change and no other writer can move it underneath the gate.
  const issueRows = (await tx.execute(
    sql`SELECT id FROM issue WHERE id = ${id} FOR UPDATE`,
  )) as unknown as { id: number }[];
  if (issueRows.length === 0) return null;
  const lockedBefore = await loadSnapshot(id, tx);
  if (lockedBefore === null) return null;
  if (lockedBefore.projectId !== before.projectId) {
    // The scope checks above ran against the project the card was in on the pool read; a card
    // that moved projects under the locks is not the write those checks cover.
    throw new HttpError(409, 'This issue moved projects while it was being updated; try again');
  }
  // A caller that conditioned the write on a column is judged here, on the locked row, before the
  // owner is asked: the owner must never judge a write this guard is about to drop.
  if (input.onlyIfColumnId != null && lockedBefore.columnId !== input.onlyIfColumnId) return null;
  if (patch.parentId != null) await assertTreeLink(id, patch.parentId, tx);
  // The pool's answers were early only: whether the write is a move at all is judged against
  // the locked row, so a card another writer already put in the target column is not counted
  // against WIP, not auto-assigned and not judged a close.
  const movedToColumnId =
    patch.columnId !== undefined && patch.columnId !== lockedBefore.columnId
      ? patch.columnId
      : null;
  // The date order is judged again from the locked dates for the side the patch does not
  // set, so a stale pool start/due pair cannot clear or fail the check.
  assertDateOrder(
    patch.startDate !== undefined ? patch.startDate : lockedBefore.startDate,
    patch.dueDate !== undefined ? patch.dueDate : lockedBefore.dueDate,
  );
  const writeSet = { ...set };
  if (movedToColumnId !== null) {
    // The limit and the auto-assignee are decided again on the locked rows.
    const breach = await wipLimitBreach(movedToColumnId, 1, tx);
    if (breach) {
      if (!skipIfColumnFull) throw breach;
      return null; // the move is dropped, the same no-write answer the ordinary path gives
    }
    if (patch.assigneeUserId !== undefined) writeSet.assigneeUserId = patch.assigneeUserId;
    else {
      const txAutoAssignee = await columnAutoAssignee(movedToColumnId, tx);
      if (txAutoAssignee) writeSet.assigneeUserId = txAutoAssignee;
      else delete writeSet.assigneeUserId;
    }
  } else if (patch.assigneeUserId === undefined) {
    // The pool saw a move the locked row does not: its auto-assignee must not ride along.
    delete writeSet.assigneeUserId;
  }
  const ops = await buildUpdateOp(tx, {
    id,
    rigId,
    lockedBefore,
    patch,
    movedToColumnId,
    set: writeSet,
    closeRequest: input.closeRequest,
    actorUserId: input.actorUserId,
  });
  const closeOp = ops.find((op) => op.op === 'close');
  if (input.closeRequest !== undefined && closeOp === undefined) {
    throw new HttpError(
      409,
      'A close request applies only to a move from an open column into a completed or canceled one',
      'close-request-without-close',
    );
  }
  // Every op is judged before the one write. A close op carries the actor kind and no skill flags: it carried neither before, which
  // hid from the owner and from the backstop below whether the writer closing the card was a person (sentinel-prod-8429).
  const actorFacts = await skillFactsFor(tx, input.actorUserId ?? null);
  for (const op of ops) {
    Object.assign(op, op.op === 'close' ? { actor_kind: actorFacts.actor_kind } : actorFacts);
    await gateIssueWrite({ rigId, op });
  }
  // The writer-side close backstop, after the gate: a close commits only on close facts this server observed and a claim row it
  // read, unless the writer is a person this server read from the database (closeBackstopApplies, sentinel-prod-8429).
  if (closeOp !== undefined && closeBackstopApplies(closeOp, actorFacts.actor_kind)) {
    throw new HttpError(
      409,
      'This issue cannot be closed until verified close facts exist',
      'close-facts-missing',
    );
  }
  const closer =
    closeOp !== undefined && input.closeRequest !== undefined
      ? closerOf(input.actorUserId, input.closeRequest)
      : null;
  return { writeSet, lockedBefore, closer, operatorClose: closeOp?.operator_close === true };
}

// The operations the rule owner judges a gated update on, in judging order, built only from facts this
// transaction read under its own locks. The bead id is the ledger's immutable fact, never
// something the title or the caller suggested; the previous and proposed states carry the
// stored labels and the column states, because the owner's size and description decisions
// judge the complete post-write state, not the delta. The description is top-level only when
// the patch carries one, so the owner's carry-forward rule compares it with the stored text;
// the states always carry it, stored or proposed. An effective assignee or delegate change
// carries the routing_facts routingFactsFor builds from stored identities and the pinned
// manifest; a move from a non-terminal state into a completed or canceled column is op 'close'.
// Its close_facts are the ones close-facts.ts observed for the server caller's close request,
// and its claim_facts are the locked claim row. With no request close_facts is null and the
// owner refuses the missing facts with its own wording. A closing move that also sets another
// field is followed by a full op 'update' for the same write. An edit of a card already in a
// terminal column stays op 'update'. A body-supplied override or routing or close fact is never
// attached: nothing the caller sent can open the gate.
async function buildUpdateOp(
  tx: DbExecutor,
  input: {
    id: number;
    rigId: number;
    lockedBefore: IssueSnapshot & { projectId: number; parentId: number | null };
    patch: IssuePatch;
    movedToColumnId: number | null;
    set: Partial<typeof issue.$inferInsert>;
    closeRequest?: CloseRequest;
    actorUserId: string | null;
  },
): Promise<Record<string, unknown>[]> {
  const { id, rigId, lockedBefore, patch, movedToColumnId, set } = input;
  const columnIds = [lockedBefore.columnId, ...(movedToColumnId !== null ? [movedToColumnId] : [])];
  const stateRows = (await tx.execute(
    sql`SELECT id, state_type, name FROM project_column WHERE id IN (${sql.join(
      columnIds.map((columnId) => sql`${columnId}`),
      sql`, `,
    )})`,
  )) as unknown as { id: number | string; state_type: string; name: string | null }[];
  // A column the card names or targets with no row is a fact the seam cannot judge: refuse
  // it instead of inventing a state.
  const stateType = (columnId: number): string => {
    const row = stateRows.find((r) => Number(r.id) === columnId);
    if (!row) throw new HttpError(404, 'Column not found');
    return row.state_type;
  };
  const labelRows = (await tx.execute(
    sql`SELECT l.name FROM issue_label il JOIN label l ON l.id = il.label_id
        WHERE il.issue_id = ${id} ORDER BY l.name`,
  )) as unknown as { name: string }[];
  const labels = labelRows.map((row) => row.name);
  const identityRows = (await tx.execute(
    sql`SELECT r.prefix, b.local_token FROM bead_identity b
        JOIN rig r ON r.id = b.rig_id
        WHERE b.issue_id = ${id} AND b.rig_id = ${rigId}`,
  )) as unknown as { prefix: string; local_token: string }[];
  // One fact of the locked rig's ledger names the card. An identity that exists only in
  // another rig, like none at all, is an identity this seam cannot judge, and the answer is
  // the caller's own 409, not a guess from the title.
  if (identityRows.length !== 1) {
    throw new HttpError(
      409,
      'This issue holds no bead identity in its rig, so its update cannot be judged',
      'issue-without-identity',
    );
  }
  const beadId = `${identityRows[0].prefix}-${identityRows[0].local_token}`;
  const previousAssignee = lockedBefore.assigneeUserId ?? null;
  const proposedAssignee = set.assigneeUserId === undefined ? previousAssignee : set.assigneeUserId;
  const previousDelegate = lockedBefore.delegateUserId ?? null;
  const proposedDelegate = set.delegateUserId === undefined ? previousDelegate : set.delegateUserId;
  const routingChanged =
    proposedAssignee !== previousAssignee || proposedDelegate !== previousDelegate;
  // A close is a move INTO a terminal state from a non-terminal one. An edit of a card that
  // already sits in a completed or canceled column, or a move between terminal columns,
  // stays op 'update' with full states: a done card keeps being editable, and the identity
  // rule owns those states.
  const targetColumnId = movedToColumnId !== null ? movedToColumnId : lockedBefore.columnId;
  const targetState = stateType(targetColumnId);
  const previousState = stateType(lockedBefore.columnId);
  const isTerminal = (state: string) => state === 'completed' || state === 'canceled';
  const isClose = movedToColumnId !== null && isTerminal(targetState) && !isTerminal(previousState);
  const previous = {
    title: lockedBefore.title,
    description: lockedBefore.description ?? '',
    labels,
    bead_id: beadId,
    column_state: previousState,
    assignee_user_id: previousAssignee,
    delegate_user_id: previousDelegate,
    parent_id: lockedBefore.parentId,
  };
  const proposed = {
    title: set.title === undefined ? lockedBefore.title : set.title,
    description: set.description === undefined ? (lockedBefore.description ?? '') : set.description,
    labels,
    bead_id: beadId,
    column_state: targetState,
    assignee_user_id: proposedAssignee,
    delegate_user_id: proposedDelegate,
    parent_id: set.parentId === undefined ? lockedBefore.parentId : set.parentId,
  };
  const ops: Record<string, unknown>[] = [];
  if (isClose) {
    const closeOp = closeOpStart(beadId, identityRows[0].prefix, stateRows, lockedBefore.columnId);
    // The close op carries no states, because the identity rule owns a whole proposed state
    // only for the mutating ops and a close with one refuses before the close rule answers.
    // WHY the facts are read here (sentinel-prod-8429 G2): the commit or artifact and the claim
    // row are observed on the transaction that holds the card's lock, so the owner judges the
    // row this write changes. With no close request the facts are null and the owner refuses.
    await attachCloseFacts(closeOp, {
      tx,
      id,
      rigPrefix: identityRows[0].prefix,
      beadId,
      request: input.closeRequest,
      projectId: lockedBefore.projectId,
      actorUserId: input.actorUserId,
    });
    ops.push(closeOp);
    // WHY a second op (Root msg_b6d390a40af4): a closing write that also sets a title, a
    // description, an assignee or a column auto-assignee is a full write, and the close op
    // cannot carry its states. The update op below is the one every other gated update is
    // judged on, so no rule is copied and nothing is dropped from the write.
    if (isBareClose(set)) return ops;
  }
  const op: Record<string, unknown> = {
    op: 'update',
    id: beadId,
    rig_prefix: identityRows[0].prefix,
  };
  ops.push(op);
  op.labels = labels;
  op.previous_state = previous;
  op.proposed_state = proposed;
  if (patch.title !== undefined) op.title = patch.title;
  // Only when the patch carries the text: a write that never names the description leaves the
  // stored text in place, and the owner's trap rule needs the bytes the write would leave to
  // judge them against the stored text it read on the same transaction.
  if (patch.description !== undefined) op.description = patch.description;
  // WHY a text change is routed too (sentinel-prod-8364, Root msg_9c74bb90114a): the owner reads a
  // lane mention in the title and the description of both states, and an op with no routing facts
  // goes to its legacy rule, which reads none. So a title or description change carries facts for
  // the agents that text names. The holders are targets only when this write changes them.
  const textChanged =
    proposed.title !== previous.title || proposed.description !== previous.description;
  if (routingChanged || textChanged) {
    if (proposedAssignee !== previousAssignee && proposedAssignee !== null)
      op.assignee = proposedAssignee;
    const routed = await routingFactsFor(tx, {
      beadId,
      projectId: lockedBefore.projectId,
      texts: [previous.title, previous.description, proposed.title, proposed.description],
      assigneeUserId: routingChanged ? proposedAssignee : null,
      delegateUserId: routingChanged ? proposedDelegate : null,
      labels,
      actorUserId: input.actorUserId,
    });
    if (routed.assigneeLane !== null) op.proposed_assignee = routed.assigneeLane;
    if (routed.delegateLane !== null) op.delegate = routed.delegateLane;
    op.routing_facts = routed.facts;
  }
  return ops;
}

// The bead identity for a new gated issue, allocated inside the caller's transaction. A
// project without a usable rig cannot create one, and the allocator's own refusal code is
// kept so the reason survives into the message.
async function allocateIssueIdentity(
  executor: IdentityTransaction,
  rigId: number,
  projectId: number,
  parentId: number | null | undefined,
  mode: AllocationMode | undefined,
): Promise<BeadAllocation> {
  const allocated = await allocateBeadToken(executor, {
    rigId,
    projectId,
    parentId: parentId ?? null,
    mode: mode ?? 'auto',
  });
  if (allocated.ok) return allocated.allocation;
  if (allocated.code === 'missing-rig') {
    throw new HttpError(409, 'This project needs a valid rig before you can create an issue');
  }
  // A parent ruled out on association answers with the same 400 an ordinary project gives, so
  // one wording covers both branches; everything else keeps the allocator's own sentence.
  if (allocated.code === 'parent-other-project' || allocated.code === 'parent-other-rig') {
    throw new HttpError(400, 'Parent must belong to this project');
  }
  throw new HttpError(409, allocated.message);
}

// Atomic per-project sequence number (the "-42" in "MKT-42"): the UPDATE takes a
// row lock on project, so concurrent createIssue calls for the same project never
// hand out the same number.
export async function createIssue(
  project: ProjectRow,
  input: NewIssueInput,
  actorUserId?: string | null,
): Promise<IssueRow> {
  await assertAssignments(project.id, input);
  await assertInitiative(project.id, input.initiativeId);
  await assertCycle(project.id, input.cycleId);
  await assertColumn(project.id, input.columnId);
  await assertWipLimit(input.columnId);
  await assertIssueType(project.id, input.typeId);
  // The subtasks feature is a project setting, so it is checked before the transaction.
  // The parent's association and the tree rules are decided inside it, under the board lock,
  // where the issue rows cannot move underneath the check.
  if (input.parentId != null) await assertProjectFeature(project.id, 'subtasks');
  assertDateOrder(input.startDate, input.dueDate);
  // Also checked by setIssueLabels below, but here it fails before the issue exists.
  await assertIssueLabels(project.id, input.labelIds);
  // An issue created in a column enters it the same way a moved one does, so the
  // column's auto-assignee applies. An assignee sent with the create wins over it.
  // Ordinary projects keep the pool read they have always used for the column's auto-assignee.
  // A gated create rereads it on its own transaction below, because that answer is a write value.
  const poolAssignee = input.assigneeUserId ?? (await columnAutoAssignee(input.columnId));
  const {
    id: issueId,
    createdAt,
    created: finished,
  } = await db
    .transaction(async (tx) => {
      // The rig is read here as a lock-order hint only. When the project is gated the allocation
      // takes the rig lock, which keeps it ahead of the board lock; the hint itself is never
      // trusted for the write.
      const rigHint = await projectRigHint(tx, project.id);
      // A gated create holds the rig row first. The identity snapshot below reads the rig's
      // counters, and the allocator's own lock re-enters this one, so both see the same held row.
      if (rigHint !== null) {
        await tx.execute(sql`SELECT id FROM rig WHERE id = ${rigHint} FOR UPDATE`);
      }
      // Every gated create takes the board lock, root creates included, because a project can
      // become gated or change rig while this transaction waits. An ordinary parent write keeps
      // taking it for the same reason it always did.
      if (rigHint !== null || input.parentId != null) {
        await lockIssueTree(tx, project.id);
      }
      if (input.parentId != null) {
        await assertTreeLink(null, input.parentId, tx, { expectedProjectId: project.id });
      }
      // The authoritative check, under the project row's write lock and held until commit: a
      // project that changed rig while this transaction waited must not receive an issue with a
      // token from the rig it has left, and an ordinary create that raced into a gated project
      // must refuse rather than write a null identity.
      const rigId = await lockProjectRig(tx, project.id);
      if (rigId !== rigHint) {
        throw new HttpError(
          409,
          'This project changed its rig while the issue was being created; try again',
        );
      }
      // The identity facts the owner is judged on are read under all three locks and BEFORE any
      // reservation, so the rig's high-water is the one the board already had, not the one this
      // create is about to make. An ordinary project reads none of it and spawns nothing.
      const facts =
        rigId === null
          ? null
          : await snapshotIdFacts(tx, {
              rigId,
              projectId: project.id,
              parentIssueId: input.parentId ?? null,
            });
      const allocation =
        rigId === null
          ? null
          : await allocateIssueIdentity(
              tx,
              rigId,
              project.id,
              input.parentId,
              input.beadAllocationMode,
            );
      // The title and description the owner sees are the exact bytes the INSERT writes, prefix
      // included. An ordinary project keeps its title and its default description untouched.
      const title = allocation === null ? input.title : `${allocation.localToken}: ${input.title}`;
      const description = input.description ?? '';
      // The assignee is a write value, so a gated create rereads it under the locks it already
      // holds rather than trusting the answer the pool gave before this transaction started. It
      // is read before the gate because the owner routes the holder the create will write.
      const assigneeUserId =
        rigId === null
          ? poolAssignee
          : (input.assigneeUserId ?? (await columnAutoAssignee(input.columnId, tx)));
      if (rigId !== null && allocation !== null && facts !== null) {
        // Label names are read through this same transaction. The ids a client sent are a lookup
        // key, never the fact the policy is given.
        const labelIds = [...new Set(input.labelIds ?? [])];
        const labelNames =
          labelIds.length === 0
            ? []
            : (
                (await tx.execute(
                  sql`SELECT name FROM label WHERE project_id = ${project.id} AND id IN (${sql.join(
                    labelIds.map((id) => sql`${id}`),
                    sql`, `,
                  )})`,
                )) as unknown as { name: string }[]
              ).map((row) => row.name);
        // existing_titles is a duplicate guard, not a dump of the rig: it carries the candidate id
        // alone, and only when the snapshot already holds that id.
        const existingTitles: Record<string, string> = {};
        if (facts.existing_ids.includes(allocation.beadId)) {
          const clash = (await tx.execute(
            sql`SELECT i.title FROM bead_identity b JOIN issue i ON i.id = b.issue_id WHERE b.rig_id = ${rigId} AND b.local_token = ${allocation.localToken}`,
          )) as unknown as { title: string }[];
          if (clash[0]) existingTitles[allocation.beadId] = clash[0].title;
        }
        // 'auto' is left out entirely: the owner chooses root or daughter from the parent it reads.
        // root and daughter go literally, and no id or mode fact is taken from the request body.
        const mode = input.beadAllocationMode ?? 'auto';
        // WHY a create is routed (sentinel-prod-8364, Root msg_8cae56f85d71): with no routing
        // facts the owner's legacy rule judges the create and reads no mention, so a new card
        // could name a fleet lane or start in an agent's hands unjudged. The targets are the
        // holders the INSERT writes and the agents the title and description name.
        const routed = await routingFactsFor(tx, {
          beadId: allocation.beadId,
          projectId: project.id,
          texts: [title, description],
          assigneeUserId: assigneeUserId ?? null,
          delegateUserId: input.delegateUserId ?? null,
          labels: labelNames,
          actorUserId: actorUserId ?? null,
        });
        await gateIssueWrite({
          rigId,
          op: {
            op: 'create',
            id: allocation.beadId,
            rig_prefix: facts.rig_prefix,
            existing_ids: facts.existing_ids,
            root_high_water: facts.root_high_water,
            parent_id: facts.parent_id,
            ...(mode === 'auto' ? {} : { id_mode: mode }),
            title,
            description,
            labels: labelNames,
            existing_titles: existingTitles,
            ...(await skillFactsFor(tx, actorUserId ?? null)),
            ...(routed.assigneeLane === null ? {} : { proposed_assignee: routed.assigneeLane }),
            ...(routed.delegateLane === null ? {} : { delegate: routed.delegateLane }),
            routing_facts: routed.facts,
            proposed_state: {
              labels: labelNames,
              title,
              description,
              bead_id: allocation.beadId,
              parent_id: facts.parent_id,
            },
          },
        });
      }
      const [seqRow] = await tx
        .update(projectTable)
        .set({ nextSequence: sql`next_sequence + 1` })
        .where(eq(projectTable.id, project.id))
        .returning({ seq: sql<number>`next_sequence - 1` });
      const sequenceNumber = Number(seqRow.seq);
      const [posRow] = await tx
        .select({ pos: sql<number>`COALESCE(MAX(${issue.position}), 0) + 1000` })
        .from(issue)
        .where(eq(issue.columnId, input.columnId));
      const [row] = await tx
        .insert(issue)
        .values({
          projectId: project.id,
          sequenceNumber,
          typeId: input.typeId ?? null,
          initiativeId: input.initiativeId ?? null,
          cycleId: input.cycleId ?? null,
          assigneeUserId,
          delegateUserId: input.delegateUserId ?? null,
          columnId: input.columnId,
          parentId: input.parentId ?? null,
          // A gated create prefixes the title with its own token, so a card's title names the
          // identity it holds. Every byte the caller sent after that prefix is preserved, and an
          // ordinary project keeps its title exactly as given.
          title,
          beadId: allocation === null ? null : allocation.beadId,
          description,
          priority: input.priority ?? null,
          estimatePoints: input.estimatePoints == null ? null : String(input.estimatePoints),
          estimateMinutes: input.estimateMinutes ?? null,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          position: Number(posRow.pos),
        })
        .returning({ id: issue.id, createdAt: issue.createdAt });
      if (allocation !== null) {
        // Inserted already attached: the C1 guard refuses a null link becoming non-null, so a
        // reserved row is not an option.
        const attached = await attachBeadIdentity(tx, { allocation, issueId: row.id });
        if (!attached.ok) throw new HttpError(409, attached.message);
        // Gated: every creation side effect runs on this transaction, so a late failure takes the
        // reserved identity, the sequence and the issue row with it instead of leaving them behind.
        const created = await finishCreate(tx, {
          projectId: project.id,
          issueId: row.id,
          createdAt: row.createdAt,
          input,
          actorUserId: actorUserId ?? null,
        });
        return { ...row, created };
      }
      return { ...row, created: null };
    })
    .catch((error) => {
      // Two shared @repo/db refusals can arrive here, and neither package can import an API
      // HttpError, so both are mapped next to the write they stopped. The owner's refusal is a
      // refusal of this write, not a server fault. The snapshot's refusal is a data-integrity one
      // and keeps the status and wording the allocator's own refusals already give a caller, so a
      // cross-project parent and a parent with no ledger row answer exactly as they did before the
      // snapshot was added. Both are thrown inside the transaction, so the reservation, the
      // sequence and the insert all roll back with them.
      if (isTrackerGateRefusal(error)) {
        const safe = error.safe_form ? ` Compliant form: ${error.safe_form}.` : '';
        throw new HttpError(409, `${error.rule}: ${error.message}.${safe}`, error.code);
      }
      if (isIdFactsRefusal(error)) {
        if (error.code === 'parent-other-project' || error.code === 'parent-other-rig') {
          throw new HttpError(400, 'Parent must belong to this project', error.code);
        }
        if (error.code === 'missing-rig') {
          throw new HttpError(
            409,
            'This project needs a valid rig before you can create an issue',
            error.code,
          );
        }
        throw new HttpError(409, error.message, error.code);
      }
      throw error;
    });

  // Gated returns the row its transaction finished; an ordinary project keeps its existing shape and
  // runs the same sequence after the commit, on the default client.
  const row: IssueRow =
    finished !== null
      ? finished
      : await finishCreate(db, {
          projectId: project.id,
          issueId,
          createdAt,
          input,
          actorUserId: actorUserId ?? null,
        });
  // Anchor-map stamp (sentinel-prod-8428): an issue whose body names code anchors gets its
  // symbol + line-anchor map stamped as a system-actor activity entry, off the write path and
  // after the issue has committed — a stamp failure never blocks or rolls back the issue.
  void stampIssueAnchors(issueId, row.description).catch(() => {});
  return row;
}

// The creation side effects, in the order they have always run. A gated create passes its transaction
// so a failure here rolls the create back with them; an ordinary project passes the default client
// after the commit, which is exactly what that branch did before this helper existed.
async function finishCreate(
  executor: DbExecutor,
  creation: {
    projectId: number;
    issueId: number;
    createdAt: Date;
    input: NewIssueInput;
    actorUserId: string | null;
  },
): Promise<IssueRow> {
  const { projectId, issueId, createdAt, input, actorUserId } = creation;
  // The first stretch of the status history starts when the issue does, so the entries of its
  // creation fall inside it.
  await recordStatusChange([issueId], input.columnId, createdAt, executor);
  await recordActivity(issueId, [{ action: 'created' }], actorUserId, executor);
  if (input.cycleId != null) await recordCycleChange(issueId, null, input.cycleId, executor);
  if (input.parentId != null)
    await recordParentChange(issueId, null, input.parentId, actorUserId, executor);
  // Suppress the label_changed event on creation - the initial labels are part of the issue.created
  // payload, so a separate change event would be redundant.
  if (input.labelIds?.length)
    await writeIssueLabels(executor, projectId, issueId, input.labelIds, actorUserId, false);
  // Read after the labels, so the payload the webhook and the inbox carry already names them.
  const created = (await getIssue(issueId, executor))!;
  // The author follows what they filed; the assignee is subscribed by the assignment notification
  // below, the same as a later assignment does.
  await autoWatchIssue(projectId, issueId, [actorUserId], executor);
  await emitIssueEvent('issue.created', created, actorUserId, {}, executor);
  // An issue created already delegated to an agent enqueues a run, the same as delegating one later.
  await enqueueDelegateRun(created, actorUserId, executor);
  await queueStatusRuns([issueId], input.columnId, actorUserId, executor);
  // An issue created already assigned to a member notifies them, the same as assigning one does.
  if (created.assigneeUserId) {
    await notifyIssueChange(
      {
        projectId,
        issueId,
        actorUserId: actorUserId ?? null,
        assignedUserId: created.assigneeUserId,
      },
      executor,
    );
  }
  // A description written on creation reaches the people it mentions, the same as one written into an
  // existing issue does.
  await notifyTextMentions(
    {
      projectId,
      issueId,
      actorUserId: actorUserId ?? null,
      sourceActivityId: null,
      before: '',
      after: created.description,
    },
    executor,
  );
  return created;
}

// The identifiers ("MKT-42") of the given issues, for the activity entries a parent
// change writes. An id with no issue is absent from the map.
async function identifiers(ids: number[], executor: DbExecutor = db): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const rows = await executor
    .select({ id: issue.id, key: projectTable.key, seq: issue.sequenceNumber })
    .from(issue)
    .innerJoin(projectTable, eq(projectTable.id, issue.projectId))
    .where(inArray(issue.id, ids));
  for (const row of rows) out.set(row.id, `${row.key}-${row.seq}`);
  return out;
}

// Writes a parent change to the feeds of every issue it concerns: the subtask reads
// which parent it moved between, each parent reads the subtask it gained or lost.
export async function recordParentChange(
  childId: number,
  before: number | null,
  after: number | null,
  actor?: ActivityActor,
  executor: DbExecutor = db,
): Promise<void> {
  const names = await identifiers(
    [childId, before, after].filter((id): id is number => id !== null),
    executor,
  );
  const child = rowSide(names.get(childId), childId);
  const parentSide = (id: number | null) => rowSide(id === null ? null : names.get(id), id);
  const entries: { issueId: number; event: ActivityInput }[] = [
    {
      issueId: childId,
      event: { action: 'parent', from: parentSide(before), to: parentSide(after) },
    },
  ];
  if (before !== null)
    entries.push({
      issueId: before,
      event: { action: 'subtask_remove', from: child },
    });
  if (after !== null)
    entries.push({
      issueId: after,
      event: { action: 'subtask_add', to: child },
    });
  await recordActivityEntries(entries, actor, executor);
}

export interface IssuePatch {
  columnId?: number;
  position?: number;
  typeId?: number | null;
  parentId?: number | null;
  initiativeId?: number | null;
  cycleId?: number | null;
  assigneeUserId?: string | null;
  delegateUserId?: string | null;
  title?: string;
  description?: string;
  priority?: string | null;
  estimatePoints?: number | null;
  estimateMinutes?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
}

// opts.onlyIfColumnId makes the write conditional: it applies only while the
// issue still sits in that column, so an automation acting on a state it read
// earlier cannot overwrite a concurrent move. A failed guard writes nothing and
// returns the current row.
//
// opts.skipIfColumnFull does the same for a hard WIP limit: the move is dropped
// instead of throwing. Automations set it, because they run after the write that
// triggered them — a throw there would report a move that already succeeded as
// failed, and abort the rest of the batch the automation is working through.
export async function updateIssue(
  id: number,
  patch: IssuePatch,
  actor?: ActivityActor,
  // WHY executor (sentinel-prod-8429 M): a caller that already holds a transaction must have THIS update judged,
  // written and finished on that transaction. Without it the snapshot, the four asserts and the WIP check read
  // the pool, so they judge a state the caller's own uncommitted writes have not reached. With no executor the
  // function keeps its exact previous geometry, including opening its own transaction.
  // opts.closeRequest comes from the bead adapter or from the typed closeRequest of PATCH
  // /issues/:issueId (Root 2026-11-15 msg_5d07db43120d). Either way it names a manifest
  // repository key, a commit or an artifact path, and an epoch; it cannot name the closer, a
  // repository path, a ref or a verified flag. On a rig-gated project it lets a closing move
  // commit once the server has observed the proof it names and the claim row. An ordinary
  // project has no gate and ignores it.
  opts?: {
    onlyIfColumnId?: number;
    skipIfColumnFull?: boolean;
    executor?: DbExecutor;
    closeRequest?: CloseRequest;
  },
): Promise<IssueRow | null> {
  const executor: DbExecutor = opts?.executor ?? db;
  const runTx = <T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> =>
    opts?.executor === undefined ? db.transaction(fn) : fn(opts.executor);
  const before = await loadSnapshot(id, executor);
  if (!before) return null;

  // Each date is checked against the effective other one: a patch sets one date
  // and leaves the stored value of the other in force.
  assertDateOrder(
    patch.startDate !== undefined ? patch.startDate : before.startDate,
    patch.dueDate !== undefined ? patch.dueDate : before.dueDate,
  );
  // WHY every guard takes the executor (sentinel-prod-8429): each one reads rows a caller's transaction may have
  // written (a member, agent, initiative, cycle or column). Judged on the pool, a patch is refused for a row that
  // exists on the transaction, or accepted against one the transaction removed.
  await assertAssignments(before.projectId, patch, executor);
  await assertInitiative(before.projectId, patch.initiativeId, executor);
  await assertCycle(before.projectId, patch.cycleId, before.cycleId, executor);
  await assertColumn(before.projectId, patch.columnId, executor);
  const movedToColumnId =
    patch.columnId !== undefined && patch.columnId !== before.columnId ? patch.columnId : null;
  // Only a move into a different column consumes capacity, so re-saving an issue
  // that already sits in a full column is never refused.
  if (movedToColumnId !== null) {
    const breach = await wipLimitBreach(movedToColumnId, 1, executor);
    if (breach && !opts?.skipIfColumnFull) throw breach;
    if (breach) return getIssue(id, executor);
  }
  await assertIssueType(before.projectId, patch.typeId, executor);
  await assertParent(before.projectId, id, patch.parentId, executor);

  // An assignee sent with the same move wins over the column's auto-assignee.
  const autoAssignee =
    movedToColumnId !== null && patch.assigneeUserId === undefined
      ? await columnAutoAssignee(movedToColumnId, executor)
      : null;

  const set: Partial<typeof issue.$inferInsert> = {};
  if (patch.columnId !== undefined) set.columnId = patch.columnId;
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.typeId !== undefined) set.typeId = patch.typeId;
  if (patch.parentId !== undefined) set.parentId = patch.parentId;
  if (patch.initiativeId !== undefined) set.initiativeId = patch.initiativeId;
  if (patch.cycleId !== undefined) set.cycleId = patch.cycleId;
  if (patch.assigneeUserId !== undefined) set.assigneeUserId = patch.assigneeUserId;
  else if (autoAssignee) set.assigneeUserId = autoAssignee;
  if (patch.delegateUserId !== undefined) set.delegateUserId = patch.delegateUserId;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.estimatePoints !== undefined)
    set.estimatePoints = patch.estimatePoints == null ? null : String(patch.estimatePoints);
  if (patch.estimateMinutes !== undefined) set.estimateMinutes = patch.estimateMinutes;
  if (patch.startDate !== undefined) set.startDate = patch.startDate;
  if (patch.dueDate !== undefined) set.dueDate = patch.dueDate;

  const changed = Object.keys(set).length > 0;
  if (changed) {
    set.updatedAt = sql`now()` as unknown as Date;
    const guard =
      opts?.onlyIfColumnId == null
        ? eq(issue.id, id)
        : and(eq(issue.id, id), eq(issue.columnId, opts.onlyIfColumnId));
    // A gated write runs the whole side-effect sequence on its own transaction, before the commit, and
    // hands the written row back; an ordinary project keeps its post-commit geometry and finishes on
    // the default client. Either way the diff is taken from the state the write actually changed.
    const outcome = await runTx(async (tx) => {
      const rigHint = await projectRigHint(tx, before.projectId);
      if (rigHint === null) {
        const writeSet = await ordinaryUpdatePrep(tx, before.projectId, patch.parentId, id, set);
        if (writeSet === null)
          return {
            wrote: false,
            after: null as IssueRow | null,
            judgedColumnId: before.columnId,
          };
        const rows = await tx.update(issue).set(writeSet).where(guard).returning({ id: issue.id });
        return {
          wrote: rows.length > 0,
          after: null as IssueRow | null,
          judgedColumnId: before.columnId,
        };
      }
      const gated = await gateUpdateWrite(tx, {
        rigHint,
        id,
        before,
        patch,
        set,
        skipIfColumnFull: opts?.skipIfColumnFull === true,
        onlyIfColumnId: opts?.onlyIfColumnId,
        actorUserId: actorId(actor),
        closeRequest: opts?.closeRequest,
      });
      if (gated === null)
        return { wrote: false, after: null as IssueRow | null, judgedColumnId: before.columnId };
      const rows = await tx
        .update(issue)
        .set(gated.writeSet)
        .where(guard)
        .returning({ id: issue.id });
      if (rows.length === 0)
        return { wrote: false, after: null as IssueRow | null, judgedColumnId: before.columnId };
      if (gated.operatorClose) await clearOperatorCloseClaim(tx, id);
      else if (gated.closer !== null) await releaseClosedClaim(tx, id, gated.closer);
      const afterTx = await getIssue(id, tx);
      if (!afterTx) {
        // The row this transaction just locked and updated must read back on the same transaction. If
        // it does not, something is wrong with the write itself: refuse here rather than letting a
        // gated write finish later on the pool.
        throw new Error('This issue could not be read back inside its own update transaction');
      }
      // The diff uses the row the gate locked, never the pool snapshot: the pool copy can be stale,
      // which would duplicate or drop status stretches, activity and notifications.
      if (afterTx) {
        await finishUpdate(tx, {
          id,
          before: gated.lockedBefore,
          after: afterTx,
          changed: true,
          actor,
        });
      }
      // WHY the cascade runs here (Office D1 on 874adc71, Root msg_721028387750): a subtask or
      // parent the automation closes is its own gated close and needs its own close facts and
      // live claim. Run after the commit, its refusal reached the caller as a 409 for a close
      // that had already committed and released its claim. On this transaction the refusal
      // rolls the primary move, the claim release, the activity and the queued rows back with
      // it. The nested updateIssue joins this transaction, so it does not wait on the rig row.
      if (gated.lockedBefore.columnId !== afterTx.columnId)
        await applySubtaskAutomation(afterTx, actor, tx);
      return { wrote: true, after: afterTx, judgedColumnId: gated.lockedBefore.columnId };
    }).catch((error) => {
      // The shared @repo/db refusal cannot import an API HttpError, so the gate's refusal is
      // mapped next to the write it stopped, the same shape the gated create gives a caller.
      // Every other throw is the writer's own and keeps its status and wording.
      if (isTrackerGateRefusal(error)) {
        const safe = error.safe_form ? ` Compliant form: ${error.safe_form}.` : '';
        throw new HttpError(409, `${error.rule}: ${error.message}.${safe}`, error.code);
      }
      throw error;
    });
    if (!outcome.wrote) return getIssue(id, executor);
    // Gated: everything, the subtask cascade included, already ran on the write's transaction.
    if (outcome.after) return outcome.after;
    const afterOrdinary = await getIssue(id, executor);
    if (afterOrdinary) {
      await finishUpdate(executor, { id, before, after: afterOrdinary, changed: true, actor });
      if (before.columnId !== afterOrdinary.columnId)
        await applySubtaskAutomation(afterOrdinary, actor, executor);
    }
    return afterOrdinary;
  }
  // Nothing to write: the sequence still runs on the default client, where its calls are no-ops when
  // the snapshot did not move, exactly as before.
  const current = await getIssue(id, executor);
  if (current) await finishUpdate(executor, { id, before, after: current, changed: false, actor });
  return current;
}

// The update side effects, in the order they have always run. A gated write passes its transaction so a
// failure here rolls the write back with them; an ordinary project passes the default client after the
// commit. The subtask cascade is not here: it calls updateIssue again, and each caller runs it after this
// sequence, on the write's transaction for a gated project and after the commit for an ordinary one.
async function finishUpdate(
  executor: DbExecutor,
  facts: {
    id: number;
    before: IssueSnapshot & { parentId: number | null };
    after: IssueRow;
    changed: boolean;
    actor?: ActivityActor;
  },
): Promise<void> {
  const { id, before, after, changed, actor } = facts;
  const afterSnapshot = snapshot(after);
  if (before.columnId !== afterSnapshot.columnId)
    await recordStatusChange([id], afterSnapshot.columnId, undefined, executor);
  await logIssueUpdate(before, afterSnapshot, actor, executor);
  await recordCycleChange(id, before.cycleId, afterSnapshot.cycleId, executor);
  if (before.parentId !== after.parentId)
    await recordParentChange(id, before.parentId, after.parentId, actor, executor);
  if (!changed) return;
  await emitIssueEvent('issue.updated', after, actor, {}, executor);
  // Granular events fire in addition to issue.updated when their field changed.
  if (before.assigneeUserId !== afterSnapshot.assigneeUserId)
    await emitIssueEvent('issue.assigned', after, actor, {}, executor);
  if (before.delegateUserId !== afterSnapshot.delegateUserId)
    await enqueueDelegateRun(after, actor, executor);
  if (before.columnId !== afterSnapshot.columnId) {
    await emitIssueEvent('issue.state_changed', after, actor, {}, executor);
    await queueStatusRuns([id], afterSnapshot.columnId, actorId(actor), executor);
  }
}

// If an issue's new delegate is an agent that reacts to delegation, queue a run so it
// can act on the issue. Skipped when the agent delegated to itself (an agent setting
// itself off). The run is executed later — by the poller or by the agent's runner —
// so the write is never blocked on it.
async function enqueueDelegateRun(
  after: IssueRow,
  actor?: ActivityActor,
  executor: DbExecutor = db,
): Promise<void> {
  const delegate = after.delegateUserId;
  if (!delegate || delegate === actorId(actor)) return;
  const agent = await getAssignTriggerAgent(after.projectId, delegate, actorId(actor), executor);
  if (!agent) return;
  await enqueueAgentRun(
    {
      agentId: agent.id,
      projectId: after.projectId,
      issueId: after.id,
      sourceActivityId: null,
      prompt: `Work item ${after.identifier}: "${after.title}" has been delegated to you. Review it and take the appropriate next step.`,
      delaySeconds: agent.delegationDelaySec,
    },
    executor,
  );
}

// Deletes an issue and everything attached to it. Field options/values, labels,
// attachments, and activity all go by their ON DELETE CASCADE on issue_id; the agents'
// conversation threads about it live outside the cascades and are deleted after. Unlike
// archiving, this cannot be undone, so nothing would ever read those threads again.
// Returns the deleted attachment rows so the caller can remove their objects from the
// store. Returns null if the issue did not exist.
export async function deleteIssue(
  issueId: number,
  actorUserId?: string | null,
): Promise<AttachmentRow[] | null> {
  // Read before the delete: the issue.deleted payload is the issue as it last read.
  const deleted = await getIssue(issueId);
  if (!deleted) return null;
  const attachments = await db.transaction(async (tx) => {
    const attachmentRows = await tx
      .select()
      .from(issueAttachment)
      .where(eq(issueAttachment.issueId, issueId));
    const removed = await tx.delete(issue).where(eq(issue.id, issueId)).returning({ id: issue.id });
    return removed.length ? attachmentRows.map(mapAttachment) : null;
  });
  if (!attachments) return null;
  await deleteThreadsWhere({ issueId });
  await emitIssueEvent('issue.deleted', deleted, actorUserId);
  return attachments;
}

// Replaces the issue's full label set (not an add/remove diff) and logs the
// added/removed labels to the activity feed. projectId is the issue's project: a
// label outside it is rejected before anything is written.
// WHY every query here takes the executor: a label change is four writes and three reads
// (the before-state, the link delete/insert, the issue's updatedAt, then the name snapshot,
// the activity rows and the webhook row). Split across the default client and the caller's
// transaction, the reads cannot see the writes — the name snapshot would miss a label the
// same transaction just added, the read-back DTO would show the old links, and a failure in
// the middle would leave links, activity and a webhook row committed while the caller's own
// work rolls back. `executor` stays LAST so `emitEvent` keeps its fourth/fifth positions and
// every existing caller keeps the default pool.
// 8364 U4: one exported door and one module-private seam. Every call that reaches setIssueLabels from
// outside this module is judged by the owner first - on the default pool and on a caller's supplied
// transaction alike, because a supplied executor is not a bypass. The private writeIssueLabels below is
// called by exactly one place, finishCreate, whose create gate already judged these exact label names
// under the locks create holds; judging the same labels again as an independent label op would re-lock
// in the wrong position and could refuse a create whose issue row is already reserved. No flag,
// capability or option on the exported signature skips the gate.
//
// Where the facts come from matters as much as the order. The stored labels, the card's title, its
// description, who holds it and its bead id are read on the locked transaction after the locks are held;
// nothing in the op is taken from the request. The rig hint only chooses the branch and the lock order,
// exactly as createIssue uses it; the locked read of project.rig_id is the authority.
//
// Why the ordinary branch is fenced rather than trusted: at this base no apps/api code writes
// project.rig_id, so activating a rig is an ordinary UPDATE of the project row wherever it runs.
// Postgres makes that UPDATE wait for any transaction holding the row FOR SHARE, makes FOR SHARE wait
// for an uncommitted UPDATE, and makes a FOR SHARE that waited re-read the newest committed row version.
// So either this save commits first - the project was ordinary when the labels landed - or the
// activation commits first, this read returns a rig, and the save refuses with 409 and zero writes.
// Reading the unlocked hint a second time would not close that window; holding the row does.
//
// The ordinary branch now runs inside one transaction, which CT and Root accepted explicitly: the label
// rows, the updatedAt, the activity rows and the queued webhook_delivery row commit together, so a
// failure in the middle leaves no partial rows. The observable output of a successful ordinary call -
// the default-argument path and emitEvent=false included - is unchanged, and the ordinary branch still
// reads no owner config and spawns nothing.
//
// On a gated project a label change can move a card in or out of a routed domain for whoever already
// holds it or for an agent its stored text names. So every real change carries the routing facts
// routingFactsFor builds from the stored holders, title and description, and the owner judges the lane
// against the proposed labels. A person holding the card is no lane and adds no target.
//
// A shared @repo/db refusal mapped to the caller-facing shape the create path already gives: 409,
// `rule: message`, and the compliant form. Local to this writer, so the create and update mappers stay
// untouched.
function labelGateRefusal(error: TrackerGateRefusal): HttpError {
  const safe = error.safe_form ? ` Compliant form: ${error.safe_form}.` : '';
  return new HttpError(409, `${error.rule}: ${error.message}.${safe}`, error.code);
}

// The label names the card actually carries, read on the locked transaction: this is the previous state,
// not something the caller declared.
async function storedLabelNames(executor: DbExecutor, issueId: number): Promise<string[]> {
  const rows = await executor
    .select({ name: label.name })
    .from(issueLabel)
    .innerJoin(label, eq(label.id, issueLabel.labelId))
    .where(eq(issueLabel.issueId, issueId))
    .orderBy(label.name);
  return rows.map((row) => row.name);
}

// The names the write would put on the card, resolved from the ids through this project's own label
// table in the requested order, so the post state is complete, deduplicated and project-scoped.
async function proposedLabelNames(
  executor: DbExecutor,
  projectId: number,
  labelIds: number[],
): Promise<string[]> {
  const ids = [...new Set(labelIds)];
  if (ids.length === 0) return [];
  const rows = await executor
    .select({ id: label.id, name: label.name })
    .from(label)
    .where(and(eq(label.projectId, projectId), inArray(label.id, ids)));
  const names = new Map(rows.map((row) => [row.id, row.name]));
  return ids.map((id) => names.get(id)).filter((name): name is string => name !== undefined);
}

// The one locked read that makes the ordinary branch safe: the project row held FOR SHARE as the first
// statement of the transaction. A non-null rig means the project became gated while this save waited, so
// nothing is written and the caller is told to try again.
async function ordinaryLabelSave(
  executor: DbExecutor,
  projectId: number,
  issueId: number,
  labelIds: number[],
  actorUserId: string | null | undefined,
  emitEvent: boolean,
): Promise<void> {
  const rows = (await executor.execute(
    sql`SELECT rig_id FROM project WHERE id = ${projectId} FOR SHARE`,
  )) as unknown as { rig_id: number | string | null }[];
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Project not found');
  if (row.rig_id !== null)
    throw new HttpError(
      409,
      'This project changed its rig while the labels were being saved; try again',
    );
  await writeIssueLabels(executor, projectId, issueId, labelIds, actorUserId, emitEvent);
}

// The label names a write would put on the card, held as a set. The stored names come back ordered by
// name and the proposed names keep the order the caller sent, so a plain list comparison would call a
// resubmission of the same labels a change and route-judge a card nobody moved.
function sameLabelSet(left: string[], right: string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((name) => b.has(name));
}

// The gated save, in the lock order every other gated writer already uses: rig, board, project row, then
// the issue row. Nothing here takes the rig or the board after holding the project, because a changed rig
// throws instead of escalating a share lock into an update lock.
async function gatedLabelSave(
  executor: DbExecutor,
  rigHint: number,
  projectId: number,
  issueId: number,
  labelIds: number[],
  actorUserId: string | null | undefined,
  emitEvent: boolean,
): Promise<void> {
  const rigs = (await executor.execute(
    sql`SELECT id, prefix FROM rig WHERE id = ${rigHint} FOR UPDATE`,
  )) as unknown as { id: number; prefix: string }[];
  const rig = rigs[0];
  if (!rig)
    throw new HttpError(
      409,
      'This project changed its rig while the labels were being saved; try again',
    );
  await lockIssueTree(executor, projectId);
  const rigId = await lockProjectRig(executor, projectId);
  if (rigId !== rigHint)
    throw new HttpError(
      409,
      'This project changed its rig while the labels were being saved; try again',
    );
  const cards = (await executor.execute(
    sql`SELECT id, project_id, title, description, assignee_user_id, delegate_user_id
        FROM issue WHERE id = ${issueId} FOR UPDATE`,
  )) as unknown as {
    id: number;
    project_id: number;
    title: string;
    description: string | null;
    assignee_user_id: string | null;
    delegate_user_id: string | null;
  }[];
  const card = cards[0];
  if (!card || Number(card.project_id) !== projectId) throw new HttpError(404, 'Issue not found');
  // The identity the owner judges is the ledger row for this issue under the rig this transaction locked,
  // built exactly the way create builds it. The mirror column on the issue row cannot stand in for it: it
  // is null on a card created while the project was ordinary, and it keeps the previous rig's token when
  // the project's rig changes, so either one would hand the owner an id that does not belong to the rig
  // whose lock is held here.
  const ledgers = (await executor.execute(
    sql`SELECT local_token FROM bead_identity WHERE issue_id = ${issueId} AND rig_id = ${rigId}`,
  )) as unknown as { local_token: string }[];
  if (ledgers.length !== 1)
    throw new HttpError(
      409,
      `Issue ${issueId} carries no ledger identity for this rig, so its labels cannot be judged`,
      'issue-without-identity',
    );
  const beadId = `${rig.prefix}-${ledgers[0].local_token}`;
  await assertIssueLabels(projectId, labelIds, executor);
  const previousLabels = await storedLabelNames(executor, issueId);
  const proposedLabels = await proposedLabelNames(executor, projectId, labelIds);
  // The description the owner is judged on is the stored one, carried forward as text: a mutable
  // full-state write must hold the description key as a string, and this writer changes no prose.
  const description = typeof card.description === 'string' ? card.description : '';
  const op: Record<string, unknown> = {
    op: 'label',
    id: beadId,
    rig_prefix: rig.prefix,
    title: card.title,
    description,
    labels: proposedLabels,
    previous_state: {
      title: card.title,
      description,
      labels: previousLabels,
      bead_id: beadId,
    },
    proposed_state: {
      title: card.title,
      description,
      labels: proposedLabels,
      bead_id: beadId,
    },
  };
  // Only a real change can move a card between routed domains. Every real change carries facts, held
  // or not: the owner reads lane mentions in the stored title and description, and without the key it
  // falls back to its legacy answer, which reads none. A card nobody holds and that names no agent
  // gets empty targets, which the owner accepts. The holders are the stored ones; the class is read
  // from the proposed labels, and the owner still sees a bearing marker the change removes, because
  // it reads both states.
  if (!sameLabelSet(previousLabels, proposedLabels)) {
    const routed = await routingFactsFor(executor, {
      beadId,
      projectId,
      // The label op carries the stored title and description, and the owner reads mentions there.
      texts: [card.title, description],
      assigneeUserId: card.assignee_user_id,
      delegateUserId: card.delegate_user_id,
      labels: proposedLabels,
      actorUserId: actorUserId ?? null,
    });
    if (routed.assigneeLane !== null) op.proposed_assignee = routed.assigneeLane;
    if (routed.delegateLane !== null) op.delegate = routed.delegateLane;
    op.routing_facts = routed.facts;
  }
  Object.assign(op, await skillFactsFor(executor, actorUserId ?? null));
  try {
    await gateIssueWrite({ rigId, op });
  } catch (error) {
    if (isTrackerGateRefusal(error)) throw labelGateRefusal(error);
    throw error;
  }
  await writeIssueLabels(executor, projectId, issueId, labelIds, actorUserId, emitEvent);
}

// The gated door. Its signature is unchanged, so every existing caller keeps the same call and the same
// default pool. The hint decides only the branch and the lock order.
export async function setIssueLabels(
  projectId: number,
  issueId: number,
  labelIds: number[],
  actorUserId?: string | null,
  emitEvent = true,
  executor: DbExecutor = db,
): Promise<void> {
  const rigHint = await projectRigHint(executor, projectId);
  if (rigHint === null) {
    if (executor === db) {
      await db.transaction(
        async (tx) =>
          await ordinaryLabelSave(tx, projectId, issueId, labelIds, actorUserId, emitEvent),
      );
      return;
    }
    await ordinaryLabelSave(executor, projectId, issueId, labelIds, actorUserId, emitEvent);
    return;
  }
  if (executor === db) {
    await db.transaction(
      async (tx) =>
        await gatedLabelSave(tx, rigHint, projectId, issueId, labelIds, actorUserId, emitEvent),
    );
    return;
  }
  await gatedLabelSave(executor, rigHint, projectId, issueId, labelIds, actorUserId, emitEvent);
}

// The writer itself: the body setIssueLabels had at this base, byte for byte apart from the signature,
// which now takes the executor first because it is the module's private seam and not a public call.
// Replaces the issue's full label set (not an add/remove diff) and logs the added/removed labels to the
// activity feed. projectId is the issue's project: a label outside it is rejected before anything is
// written. WHY every query here takes the executor: a label change is four writes and three reads (the
// before-state, the link delete/insert, the issue's updatedAt, then the name snapshot, the activity rows
// and the webhook row). Split across the default client and the caller's transaction, the reads cannot
// see the writes - the name snapshot would miss a label the same transaction just added, the read-back
// DTO would show the old links, and a failure in the middle would leave links, activity and a webhook
// row committed while the caller's own work rolls back.
async function writeIssueLabels(
  executor: DbExecutor,
  projectId: number,
  issueId: number,
  labelIds: number[],
  actorUserId?: string | null,
  emitEvent = true,
): Promise<void> {
  await assertIssueLabels(projectId, labelIds, executor);
  const beforeRows = await executor
    .select({ labelId: issueLabel.labelId })
    .from(issueLabel)
    .where(eq(issueLabel.issueId, issueId));
  const before = beforeRows.map((r) => r.labelId);
  const next = [...new Set(labelIds)];

  await executor.delete(issueLabel).where(eq(issueLabel.issueId, issueId));
  if (next.length) {
    await executor
      .insert(issueLabel)
      .values(next.map((labelId) => ({ issueId, labelId })))
      .onConflictDoNothing();
  }

  const added = next.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !next.includes(x));

  // A label change is an edit of the issue, and sorting by "recently updated" has
  // to place it accordingly.
  if (added.length > 0 || removed.length > 0) {
    await executor
      .update(issue)
      .set({ updatedAt: sql`now()` })
      .where(eq(issue.id, issueId));
  }

  const names = await labelNames(projectId, [...added, ...removed], executor);
  const events: ActivityInput[] = [];
  for (const labelId of added)
    events.push({ action: 'label_add', to: rowSide(names.get(labelId), labelId) });
  for (const labelId of removed)
    events.push({ action: 'label_remove', from: rowSide(names.get(labelId), labelId) });
  await recordActivity(issueId, events, actorUserId, executor);

  if (emitEvent && (added.length > 0 || removed.length > 0)) {
    // The read-back goes through the same executor for the same reason as the name snapshot:
    // the payload has to describe the issue as this transaction sees it.
    const issueRow = await getIssue(issueId, executor);
    if (issueRow) {
      const named = (ids: number[]) => ids.map((id) => ({ id, name: names.get(id) ?? null }));
      await emitIssueEvent(
        'issue.label_changed',
        issueRow,
        actorUserId,
        {
          labelChange: { added: named(added), removed: named(removed) },
        },
        executor,
      );
    }
  }
}

// --- Bulk actions ----------------------------------------------------------------
// Board multi-select applies one change to many issues at once. Each of these runs
// the single-issue operation per id in the request, so the per-issue side effects
// (activity feed, webhooks, delegate runs) still fire, but the client makes one
// request and refetches the board once instead of N times.

// The subset of `ids` that belong to this project (active or archived). The bulk
// routes are project-scoped by their guard; filtering here drops any id the client
// sent that is not in this project, so a bulk action can never reach across projects.
async function issuesInProject(projectId: number, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: issue.id })
    .from(issue)
    .where(and(eq(issue.projectId, projectId), inArray(issue.id, ids)));
  return rows.map((r) => r.id);
}

// Moves a cycle's unfinished issues — the ones outside a completed or canceled
// column — to another cycle, or off any cycle when targetCycleId is null. What the
// cycle finished stays on it, so it keeps recording what it delivered. Runs the
// single-issue update per issue, so each move lands in the feed like a hand-made
// one. Returns how many issues moved.
export async function transferCycleIssues(
  projectId: number,
  cycleId: number,
  targetCycleId: number | null,
  actorUserId?: string | null,
): Promise<number> {
  if (targetCycleId === cycleId) throw new HttpError(400, 'Target cycle must be a different cycle');
  await assertCycle(projectId, targetCycleId);

  const rows = await db
    .select({ id: issue.id })
    .from(issue)
    .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
    .where(
      and(
        eq(issue.cycleId, cycleId),
        isNull(issue.archivedAt),
        notInArray(projectColumn.stateType, ['completed', 'canceled']),
      ),
    );
  for (const row of rows) await updateIssue(row.id, { cycleId: targetCycleId }, actorUserId);
  return rows.length;
}

// Applies the same patch to every listed issue. Returns how many were updated.
export async function bulkUpdateIssues(
  projectId: number,
  ids: number[],
  patch: IssuePatch,
  actorUserId?: string | null,
): Promise<number> {
  const valid = await issuesInProject(projectId, ids);
  // The whole batch is checked against the limit before any of it is written:
  // per-issue checks inside the loop would move issues until the column filled up
  // and then fail, leaving the move half-applied. The column is checked first so
  // the WIP message never names a column outside this project.
  if (patch.columnId !== undefined) {
    await assertColumn(projectId, patch.columnId);
    const incoming = await countEnteringColumn(valid, patch.columnId);
    if (incoming > 0) await assertWipLimit(patch.columnId, incoming);
  }
  for (const id of valid) await updateIssue(id, patch, actorUserId);
  return valid.length;
}

// How many of the listed issues are not already in the target column — the ones a
// move would actually add to it.
async function countEnteringColumn(ids: number[], columnId: number): Promise<number> {
  if (ids.length === 0) return 0;
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issue)
    .where(and(inArray(issue.id, ids), ne(issue.columnId, columnId)));
  return count;
}

// Adds the given labels to every listed issue, keeping each issue's existing
// labels. An issue that already carries all of them is left untouched. Returns how
// many issues changed.
export async function bulkAddLabels(
  projectId: number,
  ids: number[],
  labelIds: number[],
  actorUserId?: string | null,
): Promise<number> {
  // 8364 U4: a gated bulk label change is disabled here rather than judged member by member. A bulk
  // write must validate every member before committing any, and gating each issue on its own would let
  // some cards change while others refuse. Refusing the whole operation disables it instead of bypassing
  // the gate; real gated bulk belongs to the bulk unit. Ordinary projects are unchanged.
  if ((await projectRigHint(db, projectId)) !== null)
    throw new HttpError(409, 'Bulk label changes are not available on a gated project yet');
  const add = [...new Set(labelIds)];
  await assertIssueLabels(projectId, add);
  const valid = await issuesInProject(projectId, ids);
  if (add.length === 0 || valid.length === 0) return 0;

  const rows = await db
    .select({ issueId: issueLabel.issueId, labelId: issueLabel.labelId })
    .from(issueLabel)
    .where(inArray(issueLabel.issueId, valid));
  const current = new Map<number, number[]>();
  for (const r of rows) {
    let list = current.get(r.issueId);
    if (!list) current.set(r.issueId, (list = []));
    list.push(r.labelId);
  }

  let changed = 0;
  for (const id of valid) {
    const have = current.get(id) ?? [];
    const missing = add.filter((l) => !have.includes(l));
    if (missing.length === 0) continue;
    await setIssueLabels(projectId, id, [...have, ...missing], actorUserId);
    changed++;
  }
  return changed;
}

// Archives every listed issue. Returns how many were archived (already-archived
// issues re-stamp to a no-op and still count).
export async function bulkArchiveIssues(
  projectId: number,
  ids: number[],
  actorUserId?: string | null,
): Promise<number> {
  const valid = await issuesInProject(projectId, ids);
  for (const id of valid) await archiveIssue(id, actorUserId);
  return valid.length;
}

// Deletes every listed issue. Returns the count deleted and their attachment rows
// so the caller can remove the objects from the store.
export async function bulkDeleteIssues(
  projectId: number,
  ids: number[],
  actorUserId: string | null,
): Promise<{ deleted: number; attachments: AttachmentRow[] }> {
  const valid = await issuesInProject(projectId, ids);
  const attachments: AttachmentRow[] = [];
  for (const id of valid) {
    const rows = await deleteIssue(id, actorUserId);
    if (rows) attachments.push(...rows);
  }
  return { deleted: valid.length, attachments };
}

// --- Custom field values on an issue ---------------------------------------------

export interface IssueFieldValueRow {
  fieldId: number;
  name: string;
  fieldType: CustomFieldType;
  value: string | number | boolean | null;
  // The end of a datetime_range as an ISO datetime; null for every other type.
  valueEnd: string | null;
  optionIds: number[];
}

function pickScalarValue(row: {
  valueText: string | null;
  valueNumber: string | null;
  valueBool: boolean | null;
  valueDate: string | null;
  valueDatetime: Date | null;
  valueUserId: string | null;
}): string | number | boolean | null {
  if (row.valueUserId != null) return row.valueUserId;
  if (row.valueText != null) return row.valueText;
  if (row.valueNumber != null) return Number(row.valueNumber);
  if (row.valueBool != null) return row.valueBool;
  if (row.valueDate != null) return row.valueDate;
  if (row.valueDatetime != null) return iso(row.valueDatetime);
  return null;
}

// The fields of the issue's project that apply to it (the project-wide ones plus
// its type's own), each joined with whatever value has been set for it (null if
// unset).
export async function getIssueFieldValues(issueId: number): Promise<IssueFieldValueRow[]> {
  const rows = await db
    .select({
      fieldId: customField.id,
      name: customField.name,
      fieldType: customField.fieldType,
      valueText: issueFieldValue.valueText,
      valueNumber: issueFieldValue.valueNumber,
      valueBool: issueFieldValue.valueBool,
      valueDate: issueFieldValue.valueDate,
      valueDatetime: issueFieldValue.valueDatetime,
      valueDatetimeEnd: issueFieldValue.valueDatetimeEnd,
      valueUserId: issueFieldValue.valueUserId,
    })
    .from(issue)
    .innerJoin(
      customField,
      and(
        eq(customField.projectId, issue.projectId),
        or(isNull(customField.issueTypeId), eq(customField.issueTypeId, issue.typeId)),
      ),
    )
    .leftJoin(
      issueFieldValue,
      and(eq(issueFieldValue.fieldId, customField.id), eq(issueFieldValue.issueId, issue.id)),
    )
    .where(eq(issue.id, issueId))
    .orderBy(customField.position);

  const optionRows = await db
    .select({ fieldId: issueFieldOption.fieldId, optionId: issueFieldOption.optionId })
    .from(issueFieldOption)
    .where(eq(issueFieldOption.issueId, issueId));
  const optionsByField = new Map<number, number[]>();
  for (const r of optionRows) {
    let list = optionsByField.get(r.fieldId);
    if (!list) optionsByField.set(r.fieldId, (list = []));
    list.push(r.optionId);
  }

  return rows.map((row) => ({
    fieldId: row.fieldId,
    name: row.name,
    fieldType: row.fieldType as CustomFieldType,
    value: pickScalarValue(row),
    valueEnd: row.valueDatetimeEnd ? iso(row.valueDatetimeEnd) : null,
    optionIds: optionsByField.get(row.fieldId) ?? [],
  }));
}

// A value is an acceptable url field value when it parses as an absolute
// http(s) URL. Other schemes (mailto:, javascript:, file:) are rejected.
function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

// Checked here, not in the schema: one `value` carries every field type.
function parseDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const day = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value) return value;
  }
  throw new HttpError(400, "Date must be a calendar day, 'YYYY-MM-DD'");
}

// A datetime value on the way in: an ISO datetime string, or null when unset.
// Anything else (a number, a date-only string, unparseable text) is rejected: a
// value without a time of day would land on midnight UTC, which is another day
// for most readers.
function parseDatetime(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Invalid datetime');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) throw new HttpError(400, 'Invalid datetime');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'Invalid datetime');
  return date;
}

// Enforces that a member field holds someone the project offers for it: a member of
// the project, and within the field's scope — the people only, the agents only, or
// both. An agent's bot user also holds a project_member row, so the scope decides.
async function assertFieldMember(
  projectId: number,
  scope: MemberScope | null,
  userId: string,
): Promise<void> {
  const isAgent = await isProjectAgent(projectId, userId);
  if (scope === 'agents') {
    if (!isAgent) throw new HttpError(400, 'This field takes an agent of this project');
    return;
  }
  if (!(await getMembership(projectId, userId)) || (scope === 'humans' && isAgent)) {
    throw new HttpError(400, 'This field takes a member of this project');
  }
}

// If the issue's new value for a member field is an agent that reacts to that field,
// queue a run so it can act on the issue. Skipped when the agent set itself. The run
// is executed later, so the write is never blocked on it.
async function enqueueFieldRun(
  projectId: number,
  issueId: number,
  field: CustomFieldRow,
  userId: string,
  actorUserId: string | null | undefined,
): Promise<void> {
  if (userId === actorUserId) return;
  const agent = await getFieldTriggerAgent(projectId, userId, field.id, actorUserId ?? null);
  if (!agent) return;
  const row = await getIssue(issueId);
  if (!row) return;
  await enqueueAgentRun({
    agentId: agent.id,
    projectId,
    issueId,
    sourceActivityId: null,
    trigger: 'field',
    prompt: `Work item ${row.identifier}: "${row.title}" now has you as its "${field.name}". Review it and take the appropriate next step.`,
    delaySeconds: agent.delaySec,
  });
}

// Tells the person put into a member field about it and subscribes them to the issue,
// the way an assignee is told. An agent is skipped: its bot user reads no inbox, and
// its own trigger is what starts it.
async function notifyFieldMember(
  projectId: number,
  issueId: number,
  userId: string,
  activityId: number | null,
  actorUserId: string | null | undefined,
): Promise<void> {
  if (await isProjectAgent(projectId, userId)) return;
  await notifyIssueChange({
    projectId,
    issueId,
    actorUserId: actorUserId ?? null,
    assignedUserId: userId,
    assignedActivityId: activityId,
  });
}

// The user id a member field currently holds on an issue, null when it is unset.
async function fieldMemberUserId(issueId: number, fieldId: number): Promise<string | null> {
  const [row] = await db
    .select({ valueUserId: issueFieldValue.valueUserId })
    .from(issueFieldValue)
    .where(and(eq(issueFieldValue.issueId, issueId), eq(issueFieldValue.fieldId, fieldId)));
  return row?.valueUserId ?? null;
}

// The text a markdown field currently holds on an issue, empty when it is unset.
async function fieldMarkdown(issueId: number, fieldId: number): Promise<string> {
  const [row] = await db
    .select({ valueText: issueFieldValue.valueText })
    .from(issueFieldValue)
    .where(and(eq(issueFieldValue.issueId, issueId), eq(issueFieldValue.fieldId, fieldId)));
  return row?.valueText ?? '';
}

// Sets one field's value on one issue. projectId is the issue's project: the field
// is resolved inside it, so a field id belonging to another project does not match.
// For select/multi_select fields, pass optionIds (replaces the full selection); for
// every other field type, pass value matching the field's type. A datetime_range
// takes its end in valueEnd.
export async function setIssueFieldValue(
  projectId: number,
  issueId: number,
  fieldId: number,
  input: {
    value?: string | number | boolean | null;
    valueEnd?: string | null;
    optionIds?: number[];
  },
  actorUserId?: string | null,
): Promise<void> {
  const field = await getCustomFieldById(projectId, fieldId);
  if (!field) throw new HttpError(404, 'Custom field not found');

  // A url field stores its value as text but must hold a valid http(s) URL.
  if (field.fieldType === 'url' && typeof input.value === 'string' && input.value !== '') {
    if (!isHttpUrl(input.value)) throw new HttpError(400, 'Invalid URL');
  }
  // A number field must be a finite number; the value column is numeric.
  if (field.fieldType === 'number' && input.value != null && input.value !== '') {
    if (!Number.isFinite(Number(input.value))) throw new HttpError(400, 'Invalid number');
  }
  const memberUserId =
    field.fieldType === 'member' && typeof input.value === 'string' && input.value !== ''
      ? input.value
      : null;
  if (memberUserId) await assertFieldMember(projectId, field.memberScope, memberUserId);

  // The markdown a field held before this write, so only the mentions the write
  // adds reach anyone.
  const previousMarkdown =
    field.fieldType === 'markdown' ? await fieldMarkdown(issueId, fieldId) : '';

  // Who the member field held before this write. A write that sets the same person
  // again starts no run and tells nobody.
  const previousMemberUserId =
    field.fieldType === 'member' ? await fieldMemberUserId(issueId, fieldId) : null;

  // The display-ready new value logged to the activity feed: option value names for
  // select/multi_select, the raw value for everything else. loggedId is the row that
  // value names — the chosen option, the chosen member — so the entry reads as data
  // like every other one. A multi_select names several rows and keeps its text.
  let loggedValue: string | null;
  let loggedId: number | string | null = null;

  if (field.fieldType === 'select' || field.fieldType === 'multi_select') {
    const optionIds = input.optionIds ?? [];
    // An option must be one of this field's own: the issue_field_option foreign key
    // only requires it to exist somewhere. Resolved before the delete so a rejected
    // request leaves the current selection untouched.
    const names = optionIds.map((optionId) => {
      const option = field.options.find((o) => o.id === optionId);
      if (!option) throw new HttpError(400, 'Option does not belong to this field');
      return option.value;
    });

    await db
      .delete(issueFieldOption)
      .where(and(eq(issueFieldOption.issueId, issueId), eq(issueFieldOption.fieldId, fieldId)));
    if (optionIds.length) {
      await db
        .insert(issueFieldOption)
        .values(optionIds.map((optionId) => ({ issueId, fieldId, optionId })));
    }
    loggedValue = names.length ? names.join(', ') : null;
    loggedId = optionIds.length === 1 ? optionIds[0] : null;
  } else {
    // The value column matching the field's type; the others stay NULL. Both the
    // insert and the on-conflict update write only that one column.
    let column: Partial<typeof issueFieldValue.$inferInsert>;
    switch (field.fieldType) {
      case 'number':
        column = { valueNumber: input.value == null ? null : String(input.value) };
        break;
      case 'boolean':
        column = { valueBool: input.value == null ? null : Boolean(input.value) };
        break;
      case 'date':
        column = { valueDate: parseDate(input.value) };
        break;
      case 'member':
        column = { valueUserId: memberUserId };
        break;
      case 'datetime':
        column = { valueDatetime: parseDatetime(input.value), valueDatetimeEnd: null };
        break;
      case 'datetime_range': {
        const start = parseDatetime(input.value);
        const end = parseDatetime(input.valueEnd);
        if (end && !start) throw new HttpError(400, 'Range end needs a start');
        if (start && end && end <= start) {
          throw new HttpError(400, 'Range end must be after its start');
        }
        column = { valueDatetime: start, valueDatetimeEnd: end };
        break;
      }
      default:
        column = { valueText: (input.value as string) ?? null };
    }
    await db
      .insert(issueFieldValue)
      .values({ issueId, fieldId, ...column })
      .onConflictDoUpdate({
        target: [issueFieldValue.issueId, issueFieldValue.fieldId],
        set: column,
      });
    const value = input.value;
    if (value == null || value === '') {
      loggedValue = null;
    } else if (field.fieldType === 'member') {
      loggedValue = await userName(memberUserId);
      loggedId = memberUserId;
    } else if (field.fieldType === 'boolean') {
      loggedValue = value ? 'true' : 'false';
    } else if (field.fieldType === 'datetime_range' && input.valueEnd) {
      loggedValue = `${String(value)} — ${input.valueEnd}`;
    } else {
      loggedValue = String(value);
    }
  }

  const [entry] = await recordActivity(
    issueId,
    [
      {
        action: 'field',
        subject: rowSide(field.name, field.id),
        to: rowSide(loggedValue, loggedId),
      },
    ],
    actorUserId,
  );

  if (memberUserId && memberUserId !== previousMemberUserId) {
    await enqueueFieldRun(projectId, issueId, field, memberUserId, actorUserId);
    await notifyFieldMember(projectId, issueId, memberUserId, entry?.id ?? null, actorUserId);
  }

  // A markdown field is written in the same editor as the description and reaches
  // the people it mentions the same way.
  if (field.fieldType === 'markdown') {
    await notifyTextMentions({
      projectId,
      issueId,
      actorUserId: actorUserId ?? null,
      sourceActivityId: entry?.id ?? null,
      before: previousMarkdown,
      after: typeof input.value === 'string' ? input.value : '',
    });
  }
}
