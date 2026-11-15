import { issueActivity, lockIssueTree, type DbExecutor } from '@repo/db';
import { gateIssueWrite } from '@repo/db/tracker-gate';
import { eq, sql } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import { routingFactsForText } from './lane-routing';
import { commentOp, ownerCardFacts } from './comment-op-facts';
import { actorKindOf } from './skill-facts';

// commentOp and ownerCardFacts now live in comment-op-facts.ts (sentinel-prod-8429, the module-size ceiling); both stay importable
// from here so every comment door and suite keeps the address it already uses.
export { commentOp, ownerCardFacts } from './comment-op-facts';

// The lock, history and owner-op facts the gated comment writers need, in one place.
//
// WHY this file exists: updateComment and (later) deleteComment must run their whole gated sequence on
// one transaction, in the same lock order the issue writers use, and they must hand the tracker owner
// the retained comment bodies rather than only the live ones. activity.ts cannot import issues/service.ts
// (service.ts already imports ./activity), so the two project-lock statements are issued here verbatim,
// copying service.ts projectRigHint/lockProjectRig - two queries, not a second lock layer.
//
// WHY nothing here is post-commit: every effect of a gated comment write runs on the caller's
// transaction, so a refusal or a late failure leaves no version row, no activity entry and no queued
// delivery behind. The ordinary path keeps its existing shape; the caller decides which executor it
// passes for the effects.

export interface CommentTarget {
  commentId: number;
  issueId: number;
  projectId: number;
  body: string;
  authorUserId: string | null;
  rigHint: number | null;
}

// The rig hint, unlocked: a hint is never write authority.
async function projectRigHint(executor: DbExecutor, projectId: number): Promise<number | null> {
  const rows = (await executor.execute(
    sql`SELECT rig_id FROM project WHERE id = ${projectId}`,
  )) as unknown as { rig_id: number | string | null }[];
  const row = rows[0];
  // A project that is not there is the caller's 404, not an absent rig that reads as ordinary.
  if (!row) throw new HttpError(404, 'Comment not found');
  return row.rig_id === null ? null : Number(row.rig_id);
}

// The same statement service.ts:1193 issues, for the same reason: the rig a write judged must still be
// the rig the project holds until commit.
async function lockProjectRig(executor: DbExecutor, projectId: number): Promise<number | null> {
  const rows = (await executor.execute(
    sql`SELECT rig_id FROM project WHERE id = ${projectId} FOR UPDATE`,
  )) as unknown as { rig_id: number | string | null }[];
  const row = rows[0];
  // A project that is not there is the caller's 404, not an absent rig that reads as ordinary.
  if (!row) throw new HttpError(404, 'Comment not found');
  return row.rig_id === null ? null : Number(row.rig_id);
}

// The comment the route named, as a hint only: the caller re-reads it under its own locks below.
export async function readCommentTarget(
  executor: DbExecutor,
  commentId: number,
): Promise<CommentTarget | null> {
  const rows = (await executor.execute(sql`
    SELECT a.id, a.issue_id, i.project_id, a.body, a.actor_user_id
    FROM issue_activity a JOIN issue i ON i.id = a.issue_id
    WHERE a.id = ${commentId} AND a.kind = 'comment'`)) as unknown as {
    id: number;
    issue_id: number;
    project_id: number;
    body: string | null;
    actor_user_id: string | null;
  }[];
  const row = rows[0];
  if (!row) return null;
  return {
    commentId: row.id,
    issueId: row.issue_id,
    projectId: row.project_id,
    body: row.body ?? '',
    authorUserId: row.actor_user_id,
    rigHint: await projectRigHint(executor, row.project_id),
  };
}

export interface LockedComment {
  commentId: number;
  issueId: number;
  projectId: number;
  body: string;
  authorUserId: string | null;
  rigId: number | null;
}

// The gated lock chain, in the order the issue writers use: rig, advisory tree, project (with the rig
// recheck), issue (with the project-moved recheck), then the target comment. An ordinary project takes
// the project FOR SHARE and must find no rig, which is the ordinaryUpdatePrep precedent.
export async function lockCommentForWrite(
  executor: DbExecutor,
  target: CommentTarget,
  expectedProjectId: number,
): Promise<LockedComment> {
  if (target.rigHint === null) {
    // Ordinary geometry, in W1's order: project FOR SHARE, then the issue row FOR SHARE, then the
    // comment. The issue fence is not decoration - without it a concurrent move into another project,
    // or into a gated one, would leave this edit judged on the old project while its side effects land
    // in the new one.
    const projectRows = (await executor.execute(
      sql`SELECT rig_id FROM project WHERE id = ${target.projectId} FOR SHARE`,
    )) as unknown as { rig_id: number | string | null }[];
    const projectRow = projectRows[0];
    if (!projectRow) throw new HttpError(404, 'Comment not found');
    if (projectRow.rig_id !== null && projectRow.rig_id !== undefined) {
      throw new HttpError(
        409,
        'This project changed its rig while the comment was being written; try again',
      );
    }
    const issueRows = (await executor.execute(
      sql`SELECT project_id FROM issue WHERE id = ${target.issueId} FOR SHARE`,
    )) as unknown as { project_id: number }[];
    const issueRow = issueRows[0];
    if (!issueRow) throw new HttpError(404, 'Comment not found');
    if (issueRow.project_id !== expectedProjectId) {
      throw new HttpError(409, 'This issue moved projects while it was being updated; try again');
    }
  } else {
    const rigRows = (await executor.execute(
      sql`SELECT id FROM rig WHERE id = ${target.rigHint} FOR UPDATE`,
    )) as unknown as { id: number }[];
    if (rigRows.length === 0) {
      throw new HttpError(
        409,
        'This project changed its rig while the comment was being written; try again',
      );
    }
    await lockIssueTree(executor, target.projectId);
    const rigId = await lockProjectRig(executor, target.projectId);
    if (rigId !== target.rigHint) {
      throw new HttpError(
        409,
        'This project changed its rig while the comment was being written; try again',
      );
    }
    const issueRows = (await executor.execute(
      sql`SELECT project_id FROM issue WHERE id = ${target.issueId} FOR UPDATE`,
    )) as unknown as { project_id: number }[];
    if (issueRows.length === 0) throw new HttpError(404, 'Comment not found');
    if (issueRows[0].project_id !== expectedProjectId) {
      throw new HttpError(409, 'This issue moved projects while it was being updated; try again');
    }
  }
  // The target is re-read under its own lock on both paths: the pool copy is only a hint.
  const rows = (await executor.execute(sql`
    SELECT id, issue_id, body, actor_user_id FROM issue_activity
    WHERE id = ${target.commentId} AND kind = 'comment' FOR UPDATE`)) as unknown as {
    id: number;
    issue_id: number;
    body: string | null;
    actor_user_id: string | null;
  }[];
  const row = rows[0];
  if (!row || row.issue_id !== target.issueId) throw new HttpError(404, 'Comment not found');
  return {
    commentId: row.id,
    issueId: row.issue_id,
    projectId: expectedProjectId,
    body: row.body ?? '',
    authorUserId: row.actor_user_id,
    rigId: target.rigHint,
  };
}

// Every body the issue still has: the versions already stored, then the live comments. The owner judges
// retained text on both sides of the write, so a request cannot drop it.
// The stored version bodies only. The live bodies are the caller's `liveBefore`, appended once by the op
// builder: returning them here as well duplicated every unchanged live body in both states.
export async function storedVersionBodies(
  executor: DbExecutor,
  issueId: number,
): Promise<string[]> {
  const versions = (await executor.execute(sql`
    SELECT body FROM comment_version WHERE issue_id = ${issueId}
    ORDER BY comment_id, revision`)) as unknown as { body: string }[];
  return versions.map((row) => row.body);
}

// One version row per superseded body. The revision is read after the comment's FOR UPDATE, so edits of
// one comment serialize there and the UNIQUE (comment_id, revision) backstop is never hit by a correct
// writer. author_user_id is a snapshot of the row's own author, never the actor of this change.
export async function insertVersion(
  executor: DbExecutor,
  locked: LockedComment,
  options: { deletedAfter: boolean },
): Promise<{ revision: number }> {
  const rows = (await executor.execute(sql`
    SELECT coalesce(max(revision), 0) + 1 AS next FROM comment_version
    WHERE comment_id = ${locked.commentId}`)) as unknown as { next: number }[];
  const revision = Number(rows[0].next);
  await executor.execute(sql`
    INSERT INTO comment_version (comment_id, issue_id, revision, body, author_user_id, deleted_after)
    VALUES (${locked.commentId}, ${locked.issueId}, ${revision}, ${locked.body},
            ${locked.authorUserId}, ${options.deletedAfter})`);
  return { revision };
}

// The comment_create or comment_edit op with its actor kind and its routing facts.
//
// WHY every create and edit carries facts, reached agent or not (sentinel-prod-8364, Root
// msg_9c74bb90114a): an op with no routing_facts goes to the owner's legacy rule, which reads no
// mention, so a comment naming a fleet lane that has no agent here would pass. With facts the owner
// refuses a mention that has no target. The texts are every body the owner is given, because it
// reads mentions in all of them. A delete routes nobody and keeps calling commentOp without routing facts.
//
// WHY the actor kind rides with it (sentinel-prod-8429, Misty 2026-11-15: "i guarantee you EVERY block will block me too"): a
// person commenting on her own card was judged as if she were a system write, so a lane the manifest cannot route refused her
// before the owner ever spoke. The kind is read from her database rows on this transaction, and the routing seam is given the
// same user id, so the router and the op cannot disagree about who wrote it. An agent's or a system comment keeps every refusal.
export async function routedCommentOp(
  tx: DbExecutor,
  projectId: number,
  reachedUserIds: string[],
  input: Parameters<typeof commentOp>[0],
): Promise<Record<string, unknown>> {
  const op = commentOp(input);
  op.actor_kind = await actorKindOf(tx, input.actorUserId);
  const routed = await routingFactsForText(tx, {
    projectId,
    beadId: input.facts.beadId,
    labels: input.facts.labels,
    texts: [
      input.facts.title,
      input.facts.description,
      ...input.versions,
      ...input.liveBefore.map((row) => row.body),
      ...input.superseded,
      input.editBody ?? '',
    ],
    userIds: reachedUserIds,
    actorUserId: input.actorUserId,
  });
  op.routing_facts = routed.facts;
  return op;
}

// The comment_delete op with its actor kind and, exactly as before, no routing facts.
//
// WHY (sentinel-prod-8429): the owner is given the same database-derived actor kind a create or an edit carries, so a person
// deleting a thread is not judged as a system write, while a delete still routes nobody and reaches no lane decision it never reached.
export async function commentDeleteOp(
  tx: DbExecutor,
  input: Parameters<typeof commentOp>[0],
): Promise<Record<string, unknown>> {
  const op = commentOp(input);
  op.actor_kind = await actorKindOf(tx, input.actorUserId);
  return op;
}

// The comment_create op the owner judges: the full post-write state built from the locked rows - the card's labels and identity
// as stored, the retained comments in id order, the incoming body last, with the routing facts routedCommentOp adds.
//
// WHY it stands here and not in activity.ts (sentinel-prod-8429): it is one of the three comment doors' op builders, its actor kind
// is read on the transaction it builds on, and activity.ts already stands over the module-size ceiling, so the builder moved to the
// file whose stated job is the owner-op facts the gated comment writers need. Same doors, same order, same refusal.
export async function buildCommentOp(
  tx: DbExecutor,
  input: {
    issueId: number;
    projectId: number;
    rigId: number;
    body: string;
    reachedUserIds: string[];
    actorUserId: string | null;
  },
): Promise<Record<string, unknown>> {
  // One builder for all three comment doors: this shape stays what createComment calls, and the op itself comes from commentOp, so
  // a create judges the same retained version bodies an edit does instead of only the live ones.
  const facts = await ownerCardFacts(tx, input.issueId, input.rigId);
  return routedCommentOp(tx, input.projectId, input.reachedUserIds, {
    opName: 'comment_create',
    facts,
    versions: await storedVersionBodies(tx, input.issueId),
    liveBefore: await liveCommentRows(tx, input.issueId),
    superseded: [],
    editBody: input.body,
    actorUserId: input.actorUserId,
  });
}

// The root and every comment reply under it, locked to a fixed point.
//
// WHY the loop rather than one query: a reply insert takes FOR KEY SHARE on its parent through the FK
// check, which conflicts with FOR UPDATE, so a child committed before we locked its parent is seen by the
// next round, and a child still in flight makes our lock wait and then appear. Once every row in the set
// is FOR UPDATE, no new child can attach to any of them before commit, so the FK cascade deletes exactly
// what was versioned. A cross-issue or non-comment descendant is legacy data this seam cannot version, so
// the whole delete refuses.
export async function lockCommentCascade(
  executor: DbExecutor,
  root: LockedComment,
): Promise<LockedComment[]> {
  const locked: LockedComment[] = [root];
  let frontier = [root.commentId];
  while (frontier.length > 0) {
    const rows = (await executor.execute(sql`
      SELECT id, issue_id, kind, body, actor_user_id FROM issue_activity
      WHERE reply_to_id = ANY(${sql.raw(`ARRAY[${frontier.join(',')}]::int[]`)})
        AND id <> ALL(${sql.raw(`ARRAY[${locked.map((row) => row.commentId).join(',')}]::int[]`)})
      ORDER BY id FOR UPDATE`)) as unknown as {
      id: number;
      issue_id: number | null;
      kind: string;
      body: string | null;
      actor_user_id: string | null;
    }[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.issue_id !== root.issueId || row.kind !== 'comment') {
        throw new HttpError(
          409,
          'This comment has replies this seam cannot version; delete it from the board instead',
          'comment-cascade-unsupported',
        );
      }
      locked.push({
        commentId: row.id,
        issueId: row.issue_id,
        projectId: root.projectId,
        body: row.body ?? '',
        authorUserId: row.actor_user_id,
        rigId: root.rigId,
      });
    }
    frontier = rows.map((row) => row.id);
  }
  return locked;
}

// The live comment rows in the record's order (W1's ORDER BY id), with the bodies the op needs.
export async function liveCommentRows(
  executor: DbExecutor,
  issueId: number,
): Promise<{ id: number; body: string }[]> {
  const rows = (await executor.execute(sql`
    SELECT id, body FROM issue_activity WHERE issue_id = ${issueId} AND kind = 'comment'
    ORDER BY id`)) as unknown as { id: number; body: string | null }[];
  return rows.map((row) => ({ id: row.id, body: row.body ?? '' }));
}

// The gate, on the caller's transaction. A refusal throws before any version row or body change, exactly
// the order the decision packet sets: locks, facts, op, gate, history, mutation.
export async function gateCommentOp(rigId: number, op: Record<string, unknown>): Promise<void> {
  await gateIssueWrite({ rigId, op });
}

// A comment row as the feed returns it, mapped the same way the existing writer does.
export async function readLiveComment(executor: DbExecutor, commentId: number) {
  const rows = await executor.select().from(issueActivity).where(eq(issueActivity.id, commentId));
  return rows[0] ?? null;
}
