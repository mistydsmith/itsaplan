import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
// The comment-create boundary: what the shared @repo/db gate judges BEFORE a comment lands on
// a rig-gated card, and what the ordinary path keeps unchanged — the same reviewed Python
// owner the create and update suites pin, no mock, no stub. DATABASE HELD: without the grant
// flag this file refuses before any client exists; it never resets a schema, creates a
// database, runs a migration or sender, or deletes a rig or a ledger row. RETAINED
// FIXTURES: the gated write owns its transaction and the ordinary one commits before its
// side effects, so this proof cannot roll back; this run KEEPS one named rig (RIG_PREFIX)
// plus its tombstones, removes everything else by exact id, and the last case states the
// residue.
import { sql } from 'drizzle-orm';
import {
  RIG_PREFIX,
  board,
  causeChain,
  cleanupErrors,
  cleanUp,
  commentCard,
  commentProject,
  fixtureProjects,
  one,
  residue,
  retained,
  withCommentLateFailure,
  withOwner,
} from './tracker-comment-create-fixtures';

const { createComment } = await import('../../activity');

type Refusal = { status: number; message: string; code?: string };
async function refused(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    return error as Refusal;
  }
  throw new Error('a gated comment was allowed that it should have refused');
}

describe('the comment-create boundary', () => {
  afterEach(cleanUp);

  it('allows a gated comment that keeps the retained compliance block, and commits its side effects', async () => {
    const p = await commentProject(true);
    // The description is plain and the incoming body is plain progress: the four-part block
    // lives ONLY in the retained human comment, so this allow depends on the writer reading
    // the retained comment bodies — a reader that lost them is the one the owner refuses.
    const card = await commentCard(
      p,
      'Progress note',
      'Plain card prose, no compliance block here.',
      true,
      true,
    );
    // The identity precondition the owner enforces before any other rule: the stored title
    // begins with the card's exact local token plus a separator — assert it, don't assume it.
    expect(card.localToken).not.toBeNull();
    expect(card.title).toBe(`${card.localToken}: Progress note`);
    const before = await board(p.projectId, p.rigId);
    const body = `progress: drafted section 2 @member2${p.projectId}`;
    const comment = await withOwner(() =>
      createComment({ issueId: card.issueId, body, actorUserId: p.authorId }),
    );
    const after = await board(p.projectId, p.rigId);
    // The comment row is committed with its gated side effects: one delivery, one mention
    // notification, and the member's autowatch. Nothing else on the board moved — no rig
    // counter, no identity, no status, not even the issue's own updated_at.
    expect(after).toMatchObject({
      seq: before.seq,
      root: before.root,
      issues: before.issues,
      identities: before.identities,
      updatedAt: before.updatedAt,
      labels: before.labels,
      activity: before.activity + 1,
      status: before.status,
      runs: before.runs,
      webhooks: before.webhooks,
      notifications: before.notifications + 1,
      deliveries: before.deliveries + 1,
    });
    expect(after.watchers).toBe(before.watchers + 2);
    const note = await one<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM notification
          WHERE project_id = ${p.projectId} AND user_id = ${p.member2Id} AND source_activity_id = ${comment.id}`,
    );
    expect(note.n).toBe(1);
  }, 120_000);

  it('rolls the whole gated write back when the late marker fires, proving the side effects share the comment transaction', async () => {
    const p = await commentProject(true);
    const card = await commentCard(
      p,
      'Late marker',
      'Plain card prose, no compliance block here.',
      true,
      true,
    );
    const before = await board(p.projectId, p.rigId);
    const body = `late marker note ${randomUUID()} @member2${p.projectId}`;
    const error = await withCommentLateFailure(
      p.projectId,
      body,
      { late: 'W1_LATE', early: 'W1_EARLY' },
      () =>
        withOwner(() => createComment({ issueId: card.issueId, body, actorUserId: p.authorId })),
    ).catch((e) => e);
    // LATE, not EARLY: the comment row was visible to the notification insert, so the
    // notification was written on the comment's own transaction. The raised marker rolled
    // that transaction back, so the board is exactly as it was — nothing committed.
    expect(causeChain(error)).toContain('W1_LATE');
    expect(causeChain(error)).not.toContain('W1_EARLY');
    expect(await board(p.projectId, p.rigId)).toEqual(before);
  }, 120_000);

  it('keeps the ordinary post-commit contract: the late marker fires only after the comment commits', async () => {
    const p = await commentProject(false);
    const card = await commentCard(p, 'Ordinary note', '', false, false);
    const body = `ordinary late note ${randomUUID()} @member2${p.projectId}`;
    const error = await withCommentLateFailure(
      p.projectId,
      body,
      { late: 'W1_LATE', early: 'W1_EARLY' },
      () => createComment({ issueId: card.issueId, body, actorUserId: p.authorId }),
    ).catch((e) => e);
    // LATE again, but this time the marker rode a SEPARATE transaction: the comment row
    // and the comment.created delivery are committed before the notification insert the
    // trigger sat on, which is why it is absent.
    expect(causeChain(error)).toContain('W1_LATE');
    const rows = await one<{ activity: number; deliveries: number; notifications: number }>(
      sql`SELECT (SELECT count(*)::int FROM issue_activity WHERE issue_id = ${card.issueId}) AS activity,
          (SELECT count(*)::int FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE project_id = ${p.projectId})) AS deliveries,
          (SELECT count(*)::int FROM notification WHERE project_id = ${p.projectId}) AS notifications`,
    );
    expect(rows).toEqual({ activity: 3, deliveries: 1, notifications: 0 });
  }, 120_000);

  it('refuses a gated comment that reaches an agent by mention, with the owner lane rule', async () => {
    const p = await commentProject(true);
    const card = await commentCard(
      p,
      'Agent mention',
      'Plain card prose, no compliance block here.',
      true,
      true,
    );
    const before = await board(p.projectId, p.rigId);
    const body = `please review @agent${p.projectId}`;
    const error = await refused(() =>
      withOwner(() => createComment({ issueId: card.issueId, body, actorUserId: p.authorId })),
    );
    // The owner's own lane-rule wording for the missing routing facts, mapped to a 409 —
    // and the board is exactly as it was: no comment row, nothing committed.
    expect(error.status).toBe(409);
    expect(error.code).toBe('tracker-rules-violation');
    expect(error.message).toContain('lane-routing');
    expect(error.message).toContain('routing needs routing_facts');
    expect(await board(p.projectId, p.rigId)).toEqual(before);
  }, 120_000);

  it('refuses a gated reply to an agent comment without any mention, with the owner lane rule', async () => {
    const p = await commentProject(true);
    const card = await commentCard(
      p,
      'Reply to agent',
      'Plain card prose, no compliance block here.',
      true,
      true,
    );
    const before = await board(p.projectId, p.rigId);
    const error = await refused(() =>
      withOwner(() =>
        createComment({
          issueId: card.issueId,
          body: 'what do you think of the earlier note?',
          actorUserId: p.authorId,
          replyToId: card.agentCommentId,
        }),
      ),
    );
    expect(error.status).toBe(409);
    expect(error.code).toBe('tracker-rules-violation');
    expect(error.message).toContain('lane-routing');
    expect(error.message).toContain('routing needs routing_facts');
    expect(await board(p.projectId, p.rigId)).toEqual(before);
  }, 120_000);

  it('refuses a plain progress comment on a law-library card with no compliance block anywhere', async () => {
    const p = await commentProject(true);
    // Neither the stored description, the retained comments, nor the incoming body carries a
    // block: the law-library label triggers the domain and the combined content fails the
    // owner's four-part check.
    const card = await commentCard(
      p,
      'No block',
      'Card prose with no compliance block.',
      true,
      false,
    );
    const before = await board(p.projectId, p.rigId);
    const error = await refused(() =>
      withOwner(() =>
        createComment({
          issueId: card.issueId,
          body: 'progress: drafted section 3',
          actorUserId: p.authorId,
        }),
      ),
    );
    expect(error.status).toBe(409);
    expect(error.code).toBe('tracker-rules-violation');
    expect(error.message).toContain('law-library-compliance');
    expect(error.message).toContain(
      'Law Library writes are refused until the body carries the compliance block',
    );
    expect(await board(p.projectId, p.rigId)).toEqual(before);
  }, 120_000);

  it('queues a run for an ordinary project agent mention, unchanged', async () => {
    const p = await commentProject(false);
    const card = await commentCard(p, 'Ordinary mention', '', false, false);
    const before = await board(p.projectId, null);
    const body = `agent over @agent${p.projectId}`;
    await createComment({ issueId: card.issueId, body, actorUserId: p.authorId });
    const after = await board(p.projectId, null);
    // The ordinary path keeps its post-commit contract: the mention still queues a run.
    expect(after.runs).toBe(before.runs + 1);
    const run = await one<{ trigger: string }>(
      sql`SELECT trigger FROM agent_run WHERE issue_id = ${card.issueId} ORDER BY id DESC LIMIT 1`,
    );
    expect(run.trigger).toBe('mention');
    expect(after.activity).toBe(before.activity + 1);
    expect(after.deliveries).toBe(before.deliveries + 1);
  }, 120_000);

  it('leaves nothing behind but the shared rig and its ledger tombstones', async () => {
    expect(cleanupErrors).toEqual([]);
    for (const { id } of fixtureProjects) {
      const row = await one<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM issue WHERE project_id = ${id}`,
      );
      expect(row.n).toBe(0);
    }
    expect(await residue()).toEqual({
      issues: 0,
      webhooks: 0,
      labels: 0,
      columns: 0,
      projects: 0,
      teams: 0,
      workspaces: 0,
      users: 0,
    });
    // What this run is allowed to keep: the shared synthetic rig and the ledger rows its
    // fixture cards carried, now orphaned by the issue deletions.
    const kept = await retained();
    expect(kept.rig.prefix).toBe(RIG_PREFIX);
    expect(kept.ledger.orphans).toBe(0);
  }, 120_000);
});
