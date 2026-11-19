import {
  db,
  issue,
  issueActivity,
  user,
  projectColumn,
  issueType,
  label,
  initiative,
  cycle,
  lockIssueTree,
  type ActivityPayload,
  type ActivitySide,
  type DbExecutor,
} from '@repo/db';
import { gateIssueWrite, isTrackerGateRefusal } from '@repo/db/tracker-gate';
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { HttpError, iso } from '#shared/lib';
import { emitCommentEvent } from './webhook-payload';
import { isAgentUser } from '#modules/agents/core/service';
import {
  buildCommentOp,
  commentDeleteOp,
  gateCommentOp,
  insertVersion,
  liveCommentRows,
  lockCommentCascade,
  lockCommentForWrite,
  ownerCardFacts,
  readCommentTarget,
  routedCommentOp,
  storedVersionBodies,
} from './comment-history';
import { addedMentionHandles, parseMentionHandles, resolveMentionHandles } from '#shared/mentions';
import { mentionReach, queueMentionRuns, type MentionReach } from '#modules/mentions/service';
import {
  notifyComment,
  notifyEditedCommentMentions,
  notifyIssueChange,
  notifyTextMentions,
} from '#modules/notifications/service';
import { listStatusTimeline } from './status-history';

// Issue timeline: comments and change-log activity in one table (issue_activity).
// kind selects which columns a row uses. The author is the session user
// (a member or an agent's bot user); actor_name is a snapshot taken at write time,
// so an entry keeps reading correctly after that user is renamed or deleted. The
// issue detail panel renders the feed newest first and pages through it with a
// (created_at, id) keyset cursor.

export type FeedKind = 'comment' | 'activity';

export interface FeedItemRow {
  id: number;
  issueId: number;
  kind: FeedKind;
  // The comment this one replies to, null for a top-level entry.
  replyToId: number | null;
  actorUserId: string | null;
  actorName: string | null;
  body: string | null;
  action: string | null;
  payload: ActivityPayload;
  createdAt: string;
  // Set once a comment is edited; null while it is in its author's original words.
  editedAt: string | null;
}

// Opaque page cursor: the (created_at, id) of the last returned item. id breaks
// ties when two entries share a created_at (bulk activity from one edit).
export interface FeedCursor {
  ts: string;
  id: number;
}

export interface FeedPage {
  items: FeedItemRow[];
  nextCursor: FeedCursor | null;
}

function mapFeedItem(row: {
  id: number;
  // Nullable at the column level (initiative rows share this table), but the
  // issue feed and createComment only ever handle issue rows, so it is present.
  issueId: number | null;
  kind: string;
  replyToId: number | null;
  actorUserId: string | null;
  actorName: string | null;
  body: string | null;
  action: string | null;
  payload: ActivityPayload;
  createdAt: Date;
  editedAt: Date | null;
}): FeedItemRow {
  return {
    id: row.id,
    issueId: row.issueId as number,
    kind: row.kind as FeedKind,
    replyToId: row.replyToId,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    body: row.body,
    action: row.action,
    payload: row.payload,
    createdAt: iso(row.createdAt),
    editedAt: row.editedAt ? iso(row.editedAt) : null,
  };
}

export type FeedFilter = 'comments' | 'history' | 'worklog';
export type FeedOrder = 'asc' | 'desc';

export interface FeedPageOptions {
  cursor?: FeedCursor | null;
  limit?: number;
  // Narrows the page to one tab of the activity log; absent serves every entry.
  filter?: FeedFilter;
  order?: FeedOrder;
}

// The change log is split into the time spent on the issue (its work log) and the
// rest of its history.
function feedFilterCondition(filter?: FeedFilter) {
  switch (filter) {
    case 'comments':
      return eq(issueActivity.kind, 'comment');
    case 'worklog':
      return and(eq(issueActivity.kind, 'activity'), eq(issueActivity.action, 'worklog'));
    case 'history':
      return and(eq(issueActivity.kind, 'activity'), ne(issueActivity.action, 'worklog'));
    default:
      return undefined;
  }
}

// One page of an issue's feed, newest first unless `order` is 'asc'. The page is a
// window over the top-level entries; the replies of the comments in it follow at the
// end of items, however deep they are nested, so a thread is never split across
// pages. cursor_ts is created_at as full-precision text so the returned nextCursor
// round-trips without the millisecond truncation iso() would apply. limit is clamped
// to 1..100.
export async function listFeed(issueId: number, opts: FeedPageOptions = {}): Promise<FeedPage> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const cursor = opts.cursor ?? null;
  const ascending = opts.order === 'asc';
  const direction = ascending ? asc : desc;
  const pastCursor = sql.raw(ascending ? '>' : '<');
  const rows = await db
    .select({
      id: issueActivity.id,
      issueId: issueActivity.issueId,
      kind: issueActivity.kind,
      replyToId: issueActivity.replyToId,
      actorUserId: issueActivity.actorUserId,
      actorName: issueActivity.actorName,
      body: issueActivity.body,
      action: issueActivity.action,
      payload: issueActivity.payload,
      createdAt: issueActivity.createdAt,
      editedAt: issueActivity.editedAt,
      cursorTs: sql<string>`${issueActivity.createdAt}::text`,
    })
    .from(issueActivity)
    .where(
      and(
        eq(issueActivity.issueId, issueId),
        isNull(issueActivity.replyToId),
        feedFilterCondition(opts.filter),
        cursor
          ? sql`(${issueActivity.createdAt}, ${issueActivity.id}) ${pastCursor} (${cursor.ts}::timestamptz, ${cursor.id}::integer)`
          : undefined,
      ),
    )
    .orderBy(direction(issueActivity.createdAt), direction(issueActivity.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const items = page.map(mapFeedItem);
  const replies = await listReplies(items.map((item) => item.id));
  return {
    items: [...items, ...replies],
    nextCursor: hasMore && last ? { ts: last.cursorTs, id: last.id } : null,
  };
}

// How many entries each tab of the activity log holds. A reply is a comment and
// counts as one.
export interface FeedCounts {
  all: number;
  comments: number;
  history: number;
  worklog: number;
}

export async function countFeed(issueId: number): Promise<FeedCounts> {
  const [counts] = await db
    .select({
      comments: sql<number>`count(*) FILTER (WHERE ${issueActivity.kind} = 'comment')`.mapWith(
        Number,
      ),
      worklog:
        sql<number>`count(*) FILTER (WHERE ${issueActivity.kind} = 'activity' AND ${issueActivity.action} = 'worklog')`.mapWith(
          Number,
        ),
      history:
        sql<number>`count(*) FILTER (WHERE ${issueActivity.kind} = 'activity' AND ${issueActivity.action} <> 'worklog')`.mapWith(
          Number,
        ),
    })
    .from(issueActivity)
    .where(eq(issueActivity.issueId, issueId));
  const { comments, worklog, history } = counts;
  return { all: comments + worklog + history, comments, history, worklog };
}

// Every reply under the given entries, oldest first, read one level at a time until
// a level has none. A thread is a handful of comments deep, so the loop is short and
// each level is one query.
async function listReplies(parentIds: number[]): Promise<FeedItemRow[]> {
  const replies: FeedItemRow[] = [];
  let level = parentIds;
  while (level.length > 0) {
    const rows = await db
      .select()
      .from(issueActivity)
      .where(inArray(issueActivity.replyToId, level))
      .orderBy(issueActivity.createdAt, issueActivity.id);
    replies.push(...rows.map(mapFeedItem));
    level = rows.map((row) => row.id);
  }
  return replies;
}

// The feed entries written inside one stretch of the timeline: created at or after
// `from`, and before `to` (absent for the stretch the issue is in now). Oldest
// first, and unpaged — this is the slice of the activity behind a single bar of the
// timeline, opened by a deliberate click. An entry that shares its timestamp with a
// status change belongs to the stretch that change opens, which is what the
// half-open range gives.
export async function listFeedRange(
  issueId: number,
  from: string,
  to?: string | null,
): Promise<FeedItemRow[]> {
  const fromDate = new Date(from);
  const toDate = to ? new Date(to) : null;
  if (Number.isNaN(fromDate.getTime()) || (toDate && Number.isNaN(toDate.getTime())))
    throw new HttpError(400, 'from and to must be ISO datetimes');

  const rows = await db
    .select()
    .from(issueActivity)
    .where(
      and(
        eq(issueActivity.issueId, issueId),
        gte(issueActivity.createdAt, fromDate),
        toDate ? lt(issueActivity.createdAt, toDate) : undefined,
      ),
    )
    .orderBy(issueActivity.createdAt, issueActivity.id);
  return rows.map(mapFeedItem);
}

// One stretch of the grouped feed: the status the issue was in, and the entries of
// this page that were written while it was there.
export interface FeedGroup {
  status: string | null;
  from: string;
  to: string | null;
  durationMs: number;
  // The issue had already been in this status before this stretch.
  repeat: boolean;
  items: FeedItemRow[];
}

export interface GroupedFeedPage {
  groups: FeedGroup[];
  nextCursor: FeedCursor | null;
}

// The feed split into the stretches the issue spent in one column, in the order the
// page runs. The page is the window of entries listFeed serves, under the same keyset
// cursor, so a long history is read page by page rather than whole; a stretch that
// spans a page boundary is served in both, each time with the entries of that page. A
// stretch in which nothing was written carries no entries and so gets no group.
export async function listGroupedFeed(
  issueId: number,
  opts: FeedPageOptions = {},
): Promise<GroupedFeedPage> {
  const page = await listFeed(issueId, opts);
  const timeline = page.items.length ? await listStatusTimeline(issueId) : [];
  if (timeline.length === 0) return { groups: [], nextCursor: page.nextCursor };

  const seen = new Set<string | null>();
  const segments = timeline.map((segment) => {
    const repeat = seen.has(segment.status);
    seen.add(segment.status);
    return { ...segment, repeat };
  });

  const groups: FeedGroup[] = [];
  // A reply joins the group of the thread it hangs under, wherever the issue stood
  // when it was written, so the thread stays whole.
  const groupByItemId = new Map<number, FeedGroup>();
  // The segments run oldest first. Newest-first entries move the walk back towards
  // the start, oldest-first ones forward towards the end, never both.
  const ascending = opts.order === 'asc';
  let index = ascending ? 0 : segments.length - 1;
  for (const item of page.items) {
    if (item.replyToId != null) {
      const group = groupByItemId.get(item.replyToId);
      if (!group) continue;
      group.items.push(item);
      groupByItemId.set(item.id, group);
      continue;
    }
    const at = Date.parse(item.createdAt);
    if (ascending) {
      while (index < segments.length - 1 && Date.parse(segments[index + 1].from) <= at) index++;
    } else {
      while (index > 0 && Date.parse(segments[index].from) > at) index--;
    }
    const segment = segments[index];
    const open = groups[groups.length - 1];
    if (open && open.from === segment.from) {
      open.items.push(item);
      groupByItemId.set(item.id, open);
      continue;
    }
    const group = { ...segment, items: [item] };
    groups.push(group);
    groupByItemId.set(item.id, group);
  }
  return { groups, nextCursor: page.nextCursor };
}

// A comment on a rig-tracked card is an owner-judged card write (C1: comment_create
// is a gate-covered op): the rig, the board, the project and the issue are locked in
// the same order create and update use, the owner judges the FULL post-write state —
// saved labels, saved comments, incoming body — BEFORE the INSERT, and every gated
// side effect (comment.created delivery, mention run queue, notification) runs in the
// same transaction, so a refusal rolls the whole write back. An ordinary card keeps
// today's post-commit side effects; only a short FOR SHARE fence is added so a
// project that gains a rig mid-write gets a 409 retry, never an unjudged comment.
type CreateCommentParams = {
  issueId: number;
  actorUserId?: string | null;
  body: string;
  // The comment being replied to. It has to be a comment on the same issue.
  replyToId?: number | null;
  // The name of an author without an account, such as someone writing in through a
  // build's public page. Their mentions reach nobody: they are not in the team.
  authorName?: string;
};

export async function createComment(input: CreateCommentParams): Promise<FeedItemRow> {
  const actorUserId = input.actorUserId ?? null;
  const replyToId = input.replyToId ?? null;
  // Unlocked hint read: it only chooses which fencing this write takes. Never write
  // authority — the locked rows decide.
  const hintRows = (await db.execute(
    sql`SELECT i.project_id, p.rig_id
        FROM issue i
        JOIN project p ON p.id = i.project_id
        WHERE i.id = ${input.issueId}`,
  )) as unknown as { project_id: number | string; rig_id: number | string | null }[];
  const hint = hintRows[0];
  if (!hint) throw new HttpError(404, 'Issue not found');
  const projectId = Number(hint.project_id);
  const rigHint = hint.rig_id == null ? null : Number(hint.rig_id);
  return rigHint == null
    ? ordinaryCreateComment({ params: input, actorUserId, replyToId, projectId })
    : gatedCreateComment({ params: input, actorUserId, replyToId, projectId, rigHint });
}

async function gatedCreateComment(input: {
  params: CreateCommentParams;
  actorUserId: string | null;
  replyToId: number | null;
  projectId: number;
  rigHint: number;
}): Promise<FeedItemRow> {
  try {
    return await db.transaction(async (tx) => {
      // The rig fact first: the gate is a rig-specific rule set, so its lock is held
      // before the gate is asked (the same order create and update use).
      const rigRows = (await tx.execute(
        sql`SELECT id FROM rig WHERE id = ${input.rigHint} FOR UPDATE`,
      )) as unknown as { id: number | string }[];
      if (rigRows.length === 0) {
        throw new HttpError(
          409,
          'This project changed its rig while the comment was being written; try again',
        );
      }
      // Board lock (advisory, held to commit), then the project row FOR UPDATE: a
      // project gaining or losing its rig during the write is a 409 retry, and the rig
      // it holds while locked is the rig the gate is asked on.
      await lockIssueTree(tx, input.projectId);
      const lockedRigId = await lockProjectRig(tx, input.projectId);
      if (lockedRigId === null || lockedRigId !== input.rigHint) {
        throw new HttpError(
          409,
          'This project changed its rig while the comment was being written; try again',
        );
      }
      // The issue row FOR UPDATE under the board lock.
      const issueRows = (await tx.execute(
        sql`SELECT project_id, title, description FROM issue
            WHERE id = ${input.params.issueId} FOR UPDATE`,
      )) as unknown as {
        project_id: number | string;
        title: string | null;
        description: string | null;
      }[];
      const issue = issueRows[0];
      if (!issue) throw new HttpError(404, 'Issue not found');
      if (Number(issue.project_id) !== input.projectId) {
        throw new HttpError(
          409,
          'This issue moved projects while the comment was being written; try again',
        );
      }
      // Reply validation and the author snapshot on the transaction.
      await assertReplyParent(tx, input.replyToId, input.params.issueId);
      const actorName = input.params.authorName ?? (await userName(input.actorUserId, tx));
      // The mention reach is computed once, before the gate, from the locked rows, and
      // reused for the post-INSERT queue: one reach per write. The reached agents become
      // routing targets, so the lane rule judges them from their stored identities.
      const mentioned = await resolveMentionHandles(
        input.projectId,
        input.params.authorName === undefined ? parseMentionHandles(input.params.body) : [],
        tx,
      );
      const agents = await commentReach(
        input.projectId,
        { replyToId: input.replyToId, actorUserId: input.actorUserId },
        mentioned.agentUserIds,
        tx,
      );
      // The fan-out skips a comment an agent wrote, so that comment reaches nobody.
      const actorIsAgent = input.actorUserId != null && (await isAgentUser(input.actorUserId, tx));
      const op = await buildCommentOp(tx, {
        issueId: input.params.issueId,
        projectId: input.projectId,
        rigId: lockedRigId,
        body: input.params.body,
        reachedUserIds: actorIsAgent ? [] : agents.map((agent) => agent.userId),
        actorUserId: input.actorUserId,
      });
      // The owner judges BEFORE the INSERT; a refusal rolls the whole write back.
      await gateIssueWrite({ rigId: lockedRigId, op });
      const [row] = await tx
        .insert(issueActivity)
        .values({
          issueId: input.params.issueId,
          kind: 'comment',
          replyToId: input.replyToId,
          actorUserId: input.actorUserId,
          actorName,
          body: input.params.body,
        })
        .returning();
      const comment = mapFeedItem(row);
      // The gated side effects, all on this transaction: the delivery, the run queue
      // and the inbox rows are all-or-nothing with the comment row.
      await emitCommentEvent(input.projectId, 'comment.created', comment, input.actorUserId, tx);
      await queueMentionRuns(
        {
          projectId: input.projectId,
          actorUserId: comment.actorUserId,
          agents,
          prompt: comment.body ?? '',
          source: { issueId: input.params.issueId, sourceActivityId: comment.id },
        },
        tx,
      );
      await notifyComment(input.projectId, comment, mentioned, tx);
      return comment;
    });
  } catch (error) {
    // Mapped next to the write it stopped, the same shape the gated create and update
    // give a caller. Every other throw is the writer's own and keeps its status.
    if (isTrackerGateRefusal(error)) {
      const safe = error.safe_form ? ` Compliant form: ${error.safe_form}.` : '';
      throw new HttpError(409, `${error.rule}: ${error.message}.${safe}`, error.code);
    }
    throw error;
  }
}

async function ordinaryCreateComment(input: {
  params: CreateCommentParams;
  actorUserId: string | null;
  replyToId: number | null;
  projectId: number;
}): Promise<FeedItemRow> {
  // The hint read saw no rig, so this write takes the ordinary path under a short
  // FOR SHARE fence: the project and issue rows are share-locked around the reply
  // check, the author snapshot and the INSERT, so a project that gains a rig — or an
  // issue that moves — mid-write is a 409 retry, and no comment lands unjudged.
  const comment = await db.transaction(async (tx) => {
    const rigRows = (await tx.execute(
      sql`SELECT rig_id FROM project WHERE id = ${input.projectId} FOR SHARE`,
    )) as unknown as { rig_id: number | string | null }[];
    if (rigRows.length > 0 && rigRows[0].rig_id !== null) {
      throw new HttpError(
        409,
        'This project became tracked while the comment was being written; try again',
      );
    }
    const issueRows = (await tx.execute(
      sql`SELECT project_id FROM issue WHERE id = ${input.params.issueId} FOR SHARE`,
    )) as unknown as { project_id: number | string }[];
    const issue = issueRows[0];
    if (!issue) throw new HttpError(404, 'Issue not found');
    if (Number(issue.project_id) !== input.projectId) {
      throw new HttpError(
        409,
        'This issue moved projects while the comment was being written; try again',
      );
    }
    await assertReplyParent(tx, input.replyToId, input.params.issueId);
    const actorName = input.params.authorName ?? (await userName(input.actorUserId, tx));
    const [row] = await tx
      .insert(issueActivity)
      .values({
        issueId: input.params.issueId,
        kind: 'comment',
        replyToId: input.replyToId,
        actorUserId: input.actorUserId,
        actorName,
        body: input.params.body,
      })
      .returning();
    return mapFeedItem(row);
  });
  // The ordinary path keeps today's post-commit side effects, unchanged: the comment
  // row is committed before the delivery, the run queue and the inbox.
  await emitCommentEvent(input.projectId, 'comment.created', comment, input.actorUserId);
  const mentioned = await resolveMentionHandles(
    input.projectId,
    input.params.authorName === undefined ? parseMentionHandles(comment.body ?? '') : [],
  );
  await enqueueMentionRuns(input.projectId, comment, mentioned.agentUserIds);
  await notifyComment(input.projectId, comment, mentioned);
  return comment;
}

// WHY a private copy of the rig lock instead of importing it from issues/service.ts:
// service already imports THIS file (its writers record the activity log here), so
// importing its rig readers back would close a module cycle. The SQL is the same read
// the update path runs; keep the wording in lockstep with service.ts.
//
// Takes the project row's write lock and returns the rig it holds while that lock is
// held, which is the point: another transaction can change the rig before this one
// writes, and the only way to see that is to hold the row until commit. The row is
// locked after the rig and the board on a gated path, never before them.
async function lockProjectRig(executor: DbExecutor, projectId: number): Promise<number | null> {
  const rows = (await executor.execute(
    sql`SELECT rig_id FROM project WHERE id = ${projectId} FOR UPDATE`,
  )) as unknown as { rig_id: number | string | null }[];
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Project not found');
  return row.rig_id === null ? null : Number(row.rig_id);
}

// The same reply check the ordinary path always ran, on the writer's executor so the
// gated path reads the row it will commit.
async function assertReplyParent(
  executor: DbExecutor,
  replyToId: number | null,
  issueId: number,
): Promise<void> {
  if (replyToId == null) return;
  const [parent] = await executor
    .select({ issueId: issueActivity.issueId, kind: issueActivity.kind })
    .from(issueActivity)
    .where(eq(issueActivity.id, replyToId));
  if (!parent || parent.issueId !== issueId || parent.kind !== 'comment')
    throw new HttpError(400, 'replyToId must be a comment on this issue');
}

// The comment a route guard resolves: the issue it hangs on, the project behind
// that issue, and its author, which decides whether the caller may touch it. Only
// comment rows count — an activity entry is a change log, not something to edit or
// delete. Null when there is no such comment.
export async function getCommentRef(
  commentId: number,
): Promise<{ issueId: number; projectId: number; actorUserId: string | null } | null> {
  const rows = await db
    .select({
      issueId: issueActivity.issueId,
      projectId: issue.projectId,
      actorUserId: issueActivity.actorUserId,
    })
    .from(issueActivity)
    .innerJoin(issue, eq(issue.id, issueActivity.issueId))
    .where(and(eq(issueActivity.id, commentId), eq(issueActivity.kind, 'comment')));
  const row = rows[0];
  return row?.issueId == null
    ? null
    : { issueId: row.issueId, projectId: row.projectId, actorUserId: row.actorUserId };
}

// Changes a comment's body and stamps it edited. The side effects mirror a new
// comment, scoped to what the edit changed: a change-log entry, the comment.updated
// webhook, and the mentions the edit newly adds (agents get a run, members a
// notification); a handle the comment already named is not told again. Who may
// change whose is settled by the route guard.
export async function updateComment(
  commentId: number,
  body: string,
  actorUserId: string | null,
  projectId: number,
): Promise<FeedItemRow> {
  // The pool read is only a hint: the row is re-read under its own lock inside the write.
  const hint = await readCommentTarget(db, commentId);
  if (!hint) throw new HttpError(404, 'Comment not found');
  if (hint.projectId !== projectId) throw new HttpError(404, 'Comment not found');

  // The history row and the body change are one transaction on both paths. A gated edit also runs its
  // whole effect sequence there, so a refusal or a late failure leaves no version, no activity entry and
  // no queued delivery behind; an ordinary edit keeps today's behaviour and runs the effects after the
  // commit, on the client the caller gave it.
  const outcome = await db.transaction(async (tx) => {
    const locked = await lockCommentForWrite(tx, hint, projectId);
    // The added reach is resolved ONCE, before the gate, and reused by the fan-out below: two
    // resolutions could disagree and the owner would judge facts the write never used. replyToId stays
    // null, so an edit reaches only the agents it newly names.
    let mentioned: { memberIds: string[]; agentUserIds: string[] } = {
      memberIds: [],
      agentUserIds: [],
    };
    let reach: Awaited<ReturnType<typeof mentionReach>> = { agents: [], memberIds: [] };
    if (locked.rigId !== null) {
      const added = addedMentionHandles(locked.body, body);
      mentioned =
        added.length > 0
          ? await resolveMentionHandles(projectId, added, tx)
          : { memberIds: [], agentUserIds: [] };
      // WHY the original author and not the editor: the existing helper filters and queues on the
      // comment's own author (comment.actorUserId), so a project owner editing somebody else's comment
      // must not change which agent is reached. The editor stays the activity actor.
      const reachActor = locked.authorUserId;
      reach =
        mentioned.agentUserIds.length > 0
          ? await mentionReach(
              projectId,
              reachActor,
              { on: 'issue', place: 'comment' },
              { memberIds: [], agentUserIds: mentioned.agentUserIds },
              tx,
            )
          : { agents: [], memberIds: [] };
      const facts = await ownerCardFacts(tx, locked.issueId, locked.rigId);
      const versions = await storedVersionBodies(tx, locked.issueId);
      const liveBefore = await liveCommentRows(tx, locked.issueId);
      // The same author the reach and the queue use: the fan-out skips a comment an agent wrote
      // however a human edits it, so that edit reaches nobody.
      const authorIsAgent =
        locked.authorUserId != null && (await isAgentUser(locked.authorUserId, tx));
      const op = await routedCommentOp(
        tx,
        projectId,
        authorIsAgent ? [] : reach.agents.map((agent) => agent.userId),
        {
          opName: 'comment_edit',
          facts,
          versions,
          liveBefore,
          // The body this edit supersedes, from the locked row - never the request.
          superseded: [locked.body],
          editBody: body,
          actorUserId,
        },
      );
      try {
        await gateCommentOp(locked.rigId, op);
      } catch (error) {
        // The shared gate's refusal becomes the API's own 409, exactly as the issue writers map it.
        if (isTrackerGateRefusal(error)) {
          const safe = error.safe_form ? ` Compliant form: ${error.safe_form}.` : '';
          throw new HttpError(409, `${error.rule}: ${error.message}.${safe}`, error.code);
        }
        throw error;
      }
      await insertVersion(tx, locked, { deletedAfter: false });
    } else {
      await insertVersion(tx, locked, { deletedAfter: false });
    }
    const [row] = await tx
      .update(issueActivity)
      .set({ body, editedAt: new Date() })
      .where(and(eq(issueActivity.id, commentId), eq(issueActivity.kind, 'comment')))
      .returning();
    if (!row) throw new HttpError(404, 'Comment not found');
    const written = mapFeedItem(row);
    if (locked.rigId !== null) {
      // Gated: the effects belong to this transaction.
      await recordActivity(written.issueId, [{ action: 'comment_edited' }], actorUserId, tx);
      await emitCommentEvent(projectId, 'comment.updated', written, actorUserId, tx);
      if (addedMentionHandles(locked.body, body).length > 0) {
        if (reach.agents.length > 0) {
          // Queued directly from the reach already resolved on this transaction: the private W1 helper
          // resolves its own reach on the pool, so it is not usable on a gated path without editing it.
          await queueMentionRuns(
            {
              projectId,
              actorUserId: locked.authorUserId,
              agents: reach.agents,
              prompt: written.body ?? '',
              source: { issueId: written.issueId, sourceActivityId: written.id },
            },
            tx,
          );
        }
        await notifyEditedCommentMentions(
          projectId,
          written,
          { memberIds: mentioned.memberIds, agentUserIds: mentioned.agentUserIds },
          tx,
        );
      }
    }
    return { written, gated: locked.rigId !== null, before: locked.body, issueId: locked.issueId };
  });

  if (outcome.gated) return outcome.written;
  // Ordinary: today's effects, after the commit, on the caller's client.
  await recordActivity(outcome.issueId, [{ action: 'comment_edited' }], actorUserId);
  await emitCommentEvent(projectId, 'comment.updated', outcome.written, actorUserId);
  const added = addedMentionHandles(outcome.before, body);
  if (added.length > 0) {
    const mentioned = await resolveMentionHandles(projectId, added);
    if (mentioned.agentUserIds.length > 0)
      await enqueueMentionRuns(
        projectId,
        { ...outcome.written, replyToId: null },
        mentioned.agentUserIds,
      );
    await notifyEditedCommentMentions(projectId, outcome.written, mentioned);
  }
  return outcome.written;
}

// Deletes a comment; its replies cascade away with it (reply_to_id FK). The change
// log keeps a comment_deleted entry, and subscribed webhooks receive the comment as
// it read. Returns false when there is no such comment.

// Deletes a comment; its replies cascade away with it (reply_to_id FK). The change
// log keeps a comment_deleted entry, and subscribed webhooks receive the comment as
// it read. Returns false when there is no such comment.
export async function deleteComment(
  commentId: number,
  actorUserId: string | null,
  projectId: number,
): Promise<boolean> {
  // The pool read is a hint only; the row is re-read under its lock inside the write. A comment that is
  // not there is `false`, which is what this public function has always returned.
  const hint = await readCommentTarget(db, commentId);
  if (!hint || hint.projectId !== projectId) return false;

  const outcome = await db.transaction(async (tx) => {
    const root = await lockCommentForWrite(tx, hint, projectId);
    // The root and every reply under it are locked and versioned together; a cross-issue or non-comment
    // descendant refuses the whole delete before anything is written.
    const cascade = await lockCommentCascade(tx, root);
    if (root.rigId !== null) {
      const facts = await ownerCardFacts(tx, root.issueId, root.rigId);
      const op = await commentDeleteOp(tx, {
        opName: 'comment_delete',
        facts,
        versions: await storedVersionBodies(tx, root.issueId),
        liveBefore: await liveCommentRows(tx, root.issueId),
        // Every body this delete removes, from the locked rows - never from the request.
        superseded: cascade.map((row) => row.body),
        actorUserId,
      });
      try {
        await gateCommentOp(root.rigId, op);
      } catch (error) {
        if (isTrackerGateRefusal(error)) {
          const safe = error.safe_form ? ` Compliant form: ${error.safe_form}.` : '';
          throw new HttpError(409, `${error.rule}: ${error.message}.${safe}`, error.code);
        }
        throw error;
      }
    }
    // One final version per locked comment, carrying that row's own original author, before removal.
    for (const row of cascade) await insertVersion(tx, row, { deletedAfter: true });
    const [before] = await tx
      .select()
      .from(issueActivity)
      .where(and(eq(issueActivity.id, commentId), eq(issueActivity.kind, 'comment')));
    if (!before) return { removed: false, written: null, issueId: 0, gated: root.rigId !== null };
    // The root goes; the replies follow through the existing reply_to_id cascade, exactly as today.
    await tx.delete(issueActivity).where(eq(issueActivity.id, commentId));
    const written = mapFeedItem(before);
    if (root.rigId !== null) {
      await recordActivity(root.issueId, [{ action: 'comment_deleted' }], actorUserId, tx);
      await emitCommentEvent(projectId, 'comment.deleted', written, actorUserId, tx);
    }
    return { removed: true, written, issueId: root.issueId, gated: root.rigId !== null };
  });

  if (!outcome.removed || !outcome.written) return false;
  if (outcome.gated) return true;
  // Ordinary: today's two effects, after the commit, on the default client.
  await recordActivity(outcome.issueId, [{ action: 'comment_deleted' }], actorUserId);
  await emitCommentEvent(projectId, 'comment.deleted', outcome.written, actorUserId);
  return true;
}

// The read-only half of enqueueMentionRuns: who is reached by mention or reply, from
// the locked rows on the given executor. The gated create path calls this BEFORE the
// gate and reuses the result for the post-INSERT queue, so one reach per write; the
// ordinary path and the update path keep the combined helper below.
async function commentReach(
  projectId: number,
  comment: { replyToId: number | null; actorUserId: string | null },
  mentionedAgentUserIds: string[],
  executor: DbExecutor,
): Promise<MentionReach['agents']> {
  if (mentionedAgentUserIds.length === 0 && comment.replyToId == null) return [];
  const reachedUserIds = new Set(mentionedAgentUserIds);
  if (comment.replyToId != null) {
    const [parent] = await executor
      .select({ actorUserId: issueActivity.actorUserId })
      .from(issueActivity)
      .where(eq(issueActivity.id, comment.replyToId));
    if (parent?.actorUserId) reachedUserIds.add(parent.actorUserId);
  }
  const { agents } = await mentionReach(
    projectId,
    comment.actorUserId,
    { on: 'issue', place: 'comment' },
    { memberIds: [], agentUserIds: [...reachedUserIds] },
    executor,
  );
  return agents;
}

// If the comment reaches agents, queue a run for each so they can reply. A mention
// reaches the agents it names; a reply reaches the author of the comment it answers,
// so answering an agent in its own thread does not have to tag it again. Only quick
// queries run here; the work happens later — in the poller for an internal agent, on
// the operator's runner for an external one — so creating a comment is never blocked
// on it. The executor defaults to the pool client: the ordinary path and the update
// path queue after their writes commit, exactly as before; the gated create path never
// calls this combined helper — it reaches before the gate and queues after the INSERT,
// both on the write's transaction.
async function enqueueMentionRuns(
  projectId: number,
  comment: FeedItemRow,
  mentionedAgentUserIds: string[],
  executor: DbExecutor = db,
): Promise<void> {
  const agents = await commentReach(
    projectId,
    { replyToId: comment.replyToId, actorUserId: comment.actorUserId },
    mentionedAgentUserIds,
    executor,
  );
  await queueMentionRuns(
    {
      projectId,
      actorUserId: comment.actorUserId,
      agents,
      prompt: comment.body ?? '',
      source: { issueId: comment.issueId, sourceActivityId: comment.id },
    },
    executor,
  );
}

// --- Activity log ----------------------------------------------------------------
// recordActivity writes change-log entries into the shared feed (kind 'activity');
// the issue mutation functions call it. The issue detail panel renders these
// together with comments as one timeline.

// Every side of every entry is built here, so the log holds one shape: the text as
// the feed shows it, and the id of the row behind it wherever there is one.

// A value with no row of its own — a title, a priority, a date. Dropped when there
// is nothing to say.
export function textSide(value: string | null | undefined): ActivitySide | undefined {
  return value == null ? undefined : { value };
}

// A value that names a row: its text snapshot, so the entry keeps reading after a
// rename or a delete, and its id, so the entry stays readable as data. Falls back to
// text when there is no row behind the value.
export function rowSide(
  value: string | null | undefined,
  id: number | string | null | undefined,
): ActivitySide | undefined {
  return id == null ? textSide(value) : { value: value ?? null, id };
}

// The side a status change writes: the column, plus the state type it carries at
// this moment — what it was later is not recoverable, and the metrics read it.
export function statusSide(column: { id: number; name: string; stateType: string }): ActivitySide {
  return { value: column.name, id: column.id, stateType: column.stateType };
}

export interface ActivityInput extends ActivityPayload {
  action: string;
}

// The actor behind a write: the session user's id (a member or an agent's bot
// user), null/undefined for an anonymous system write, or a named system actor
// ({ system: 'GitHub' }) whose name is stored as the entry's actor_name without a
// user behind it.
export type ActivityActor = string | null | undefined | { system: string };

// The user id of an actor, or null when it is a system write.
export function actorId(actor: ActivityActor): string | null {
  return typeof actor === 'string' ? actor : null;
}

// Records the given events for an issue. actor_name is snapshotted from the actor
// so the entry survives the user being renamed or deleted.
export async function recordActivity(
  issueId: number,
  events: ActivityInput[],
  actor?: ActivityActor,
  executor: DbExecutor = db,
): Promise<{ id: number; action: string | null }[]> {
  return recordActivityEntries(
    events.map((event) => ({ issueId, event })),
    actor,
    executor,
  );
}

// Records one event for a set of issues in a single insert. For the writes that
// change many issues at once (deleting a column reassigns all of its issues),
// where a recordActivity per issue would be a query each.
export async function recordActivityForIssues(
  issueIds: number[],
  event: ActivityInput,
  actor?: ActivityActor,
  executor: DbExecutor = db,
): Promise<void> {
  await recordActivityEntries(
    issueIds.map((issueId) => ({ issueId, event })),
    actor,
    executor,
  );
}

// Records a set of (issue, event) pairs in one insert, for a write that logs a
// different event on each of the issues it touches — linking two issues writes the
// relation to both, each from its own side. `on` runs it inside the caller's
// transaction. The actor name snapshot is a sub-select, so this stays one query.
export async function recordActivityEntries(
  entries: { issueId: number; event: ActivityInput }[],
  actor?: ActivityActor,
  on: DbExecutor = db,
): Promise<{ id: number; action: string | null }[]> {
  if (!entries.length) return [];
  const resolvedActorId = actorId(actor);
  const actorName =
    actor && typeof actor === 'object'
      ? actor.system
      : resolvedActorId
        ? sql<
            string | null
          >`(select ${user.name} from ${user} where ${user.id} = ${resolvedActorId})`
        : null;
  return on
    .insert(issueActivity)
    .values(
      entries.map(({ issueId, event: { action, ...payload } }) => ({
        issueId,
        kind: 'activity' as const,
        actorUserId: resolvedActorId,
        actorName,
        action,
        payload,
      })),
    )
    .returning({ id: issueActivity.id, action: issueActivity.action });
}

// The sides that read their text from the row they name, looked up at change time.
async function columnSide(id: number | null, executor: DbExecutor = db) {
  if (id == null) return undefined;
  const rows = await executor
    .select({ id: projectColumn.id, name: projectColumn.name, stateType: projectColumn.stateType })
    .from(projectColumn)
    .where(eq(projectColumn.id, id));
  return rows[0] ? statusSide(rows[0]) : undefined;
}
async function typeSide(id: number | null, executor: DbExecutor = db) {
  if (id == null) return undefined;
  const rows = await executor
    .select({ name: issueType.name })
    .from(issueType)
    .where(eq(issueType.id, id));
  return rowSide(rows[0]?.name, id);
}
async function initiativeSide(id: number | null, executor: DbExecutor = db) {
  if (id == null) return undefined;
  const rows = await executor
    .select({ title: initiative.title })
    .from(initiative)
    .where(eq(initiative.id, id));
  return rowSide(rows[0]?.title, id);
}
async function cycleSide(id: number | null, executor: DbExecutor = db) {
  if (id == null) return undefined;
  const rows = await executor.select({ name: cycle.name }).from(cycle).where(eq(cycle.id, id));
  return rowSide(rows[0]?.name, id);
}
export async function userSide(id: string | null, executor: DbExecutor = db) {
  return rowSide(await userName(id, executor), id);
}
export async function userName(
  id: string | null,
  executor: DbExecutor = db,
): Promise<string | null> {
  if (id == null) return null;
  const rows = await executor.select({ name: user.name }).from(user).where(eq(user.id, id));
  return rows[0]?.name ?? null;
}
// Name snapshots for a set of labels in one query, resolved at change time so a log
// entry keeps reading correctly after a label is renamed or deleted. An id outside
// projectId, or with no label at all, is absent from the map.
export async function labelNames(
  projectId: number,
  ids: number[],
  executor: DbExecutor = db,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const rows = await executor
    .select({ id: label.id, name: label.name })
    .from(label)
    .where(and(eq(label.projectId, projectId), inArray(label.id, ids)));
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

// The subset of an issue's fields the change log diffs.
export interface IssueSnapshot {
  id: number;
  title: string;
  description: string;
  columnId: number;
  typeId: number | null;
  initiativeId: number | null;
  cycleId: number | null;
  assigneeUserId: string | null;
  delegateUserId: string | null;
  priority: string | null;
  estimatePoints: number | null;
  estimateMinutes: number | null;
  startDate: string | null;
  dueDate: string | null;
}

// A duration as the feed shows it, the same wording the issue properties use:
// 90 -> '1h 30m', 120 -> '2h', 30 -> '30m'.
export function timeText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function estimateTimeText(minutes: number | null): string | null {
  return minutes == null ? null : timeText(minutes);
}

// Diffs an issue's before/after state and records one event per changed field.
// Priority and dates are stored as their raw value (the UI maps priority to a
// label and formats dates); description stores only the new value (it is long,
// shown in a popover in the feed). Position is intentionally not logged —
// reordering within a column is not a meaningful change.
export async function logIssueUpdate(
  before: IssueSnapshot,
  after: IssueSnapshot,
  actor?: ActivityActor,
  executor: DbExecutor = db,
): Promise<void> {
  const events: ActivityInput[] = [];
  if (before.title !== after.title)
    events.push({ action: 'title', from: textSide(before.title), to: textSide(after.title) });
  if (before.description !== after.description)
    events.push({ action: 'description', to: textSide(after.description) });
  if (before.columnId !== after.columnId)
    events.push({
      action: 'status',
      from: await columnSide(before.columnId, executor),
      to: await columnSide(after.columnId, executor),
    });
  if (before.typeId !== after.typeId)
    events.push({
      action: 'type',
      from: await typeSide(before.typeId, executor),
      to: await typeSide(after.typeId, executor),
    });
  if (before.initiativeId !== after.initiativeId)
    events.push({
      action: 'initiative',
      from: await initiativeSide(before.initiativeId, executor),
      to: await initiativeSide(after.initiativeId, executor),
    });
  if (before.cycleId !== after.cycleId)
    events.push({
      action: 'cycle',
      from: await cycleSide(before.cycleId, executor),
      to: await cycleSide(after.cycleId, executor),
    });
  if (before.assigneeUserId !== after.assigneeUserId)
    events.push({
      action: 'assignee',
      from: await userSide(before.assigneeUserId, executor),
      to: await userSide(after.assigneeUserId, executor),
    });
  if (before.delegateUserId !== after.delegateUserId)
    events.push({
      action: 'delegate',
      from: await userSide(before.delegateUserId, executor),
      to: await userSide(after.delegateUserId, executor),
    });
  if ((before.priority ?? '') !== (after.priority ?? ''))
    events.push({
      action: 'priority',
      from: textSide(before.priority),
      to: textSide(after.priority),
    });
  if (before.estimatePoints !== after.estimatePoints)
    events.push({
      action: 'estimate',
      subject: { value: 'points' },
      from: textSide(before.estimatePoints?.toString()),
      to: textSide(after.estimatePoints?.toString()),
    });
  if (before.estimateMinutes !== after.estimateMinutes)
    events.push({
      action: 'estimate',
      subject: { value: 'time' },
      from: textSide(estimateTimeText(before.estimateMinutes)),
      to: textSide(estimateTimeText(after.estimateMinutes)),
    });
  if (before.startDate !== after.startDate)
    events.push({
      action: 'start_date',
      from: textSide(before.startDate),
      to: textSide(after.startDate),
    });
  if (before.dueDate !== after.dueDate)
    events.push({
      action: 'due_date',
      from: textSide(before.dueDate),
      to: textSide(after.dueDate),
    });
  const inserted = await recordActivity(after.id, events, actor, executor);

  // Inbox notifications for the events with a dedicated notification type: a new
  // assignee, a status change, and the mentions a rewritten description added. Each
  // links back to its activity row.
  const assigneeChanged = before.assigneeUserId !== after.assigneeUserId;
  const statusChanged = before.columnId !== after.columnId;
  const descriptionChanged = before.description !== after.description;
  if (!assigneeChanged && !statusChanged && !descriptionChanged) return;
  const [row] = await executor
    .select({ projectId: issue.projectId })
    .from(issue)
    .where(eq(issue.id, after.id));
  if (!row) return;

  const idByAction = new Map(inserted.map((r) => [r.action, r.id]));
  if (assigneeChanged || statusChanged) {
    await notifyIssueChange(
      {
        projectId: row.projectId,
        issueId: after.id,
        actorUserId: actorId(actor),
        assignedUserId: assigneeChanged ? after.assigneeUserId : null,
        assignedActivityId: idByAction.get('assignee') ?? null,
        statusChanged,
        statusActivityId: idByAction.get('status') ?? null,
      },
      executor,
    );
  }
  if (descriptionChanged) {
    await notifyTextMentions(
      {
        projectId: row.projectId,
        issueId: after.id,
        actorUserId: actorId(actor),
        sourceActivityId: idByAction.get('description') ?? null,
        before: before.description,
        after: after.description,
      },
      executor,
    );
  }
}
