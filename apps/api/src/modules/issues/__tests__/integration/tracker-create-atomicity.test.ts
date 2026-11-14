import { afterEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';

// The actual gated create writer, end to end. The allow case shows each side effect queued exactly once,
// which a post-commit implementation can also satisfy; the DISCRIMINATING case is the late failure,
// where the whole board must return to its before state, which only an implementation that runs the
// sequence on the create's own transaction can pass. The fixture module below is synthetic rows and
// readback only; there is no app mock, no stubbed gate and no exported test seam.
//
// DATABASE HELD: the fixture guard refuses before any client exists unless Root set the grant flag on
// the serial DB GO. This file is prepared source; it is not run until that GO.
import {
  board,
  causeChain,
  cleanUp,
  cleanupErrors,
  createFixture,
  fixtureProjects,
  issuesIn,
  made,
  minted,
  one,
  residue,
  retained,
  RIG_PREFIX,
  withLateFailure,
  withOwner,
} from './tracker-create-atomicity-fixtures';
import type { CreateFixture } from './tracker-create-atomicity-fixtures';

const { createIssue } = await import('../../service');
const { getProjectById } = await import('../../../projects/service');

// The writer's return value says nothing about what it queued, so these read the board back.
async function create(f: CreateFixture, title: string): Promise<number> {
  const projectRow = await getProjectById(f.projectId);
  if (!projectRow) throw new Error('project missing');
  const created = await createIssue(
    projectRow,
    {
      columnId: f.columnId,
      title,
      labelIds: [f.sizeLabelId, f.featureLabelId],
      assigneeUserId: f.assigneeId,
      delegateUserId: f.agentUserId,
    },
    f.authorId,
  );
  made.issue.push(created.id);
  return created.id;
}

interface OwnedFacts {
  bead_id: string | null;
  title: string;
  labels: number;
  activity: number;
  label_events: number;
  status: number;
  watchers: number;
  notifications: number;
  deliveries: number;
  runs: number;
  activity_actor: string | null;
  notification_actor: string | null;
}

// The identity a create holds, and the exact owned rows its side effects must have written once.
async function facts(issueId: number, projectId: number): Promise<OwnedFacts> {
  return one<OwnedFacts>(sql`
    SELECT (SELECT bead_id FROM issue WHERE id = ${issueId}) AS bead_id,
      (SELECT title FROM issue WHERE id = ${issueId}) AS title,
      (SELECT count(*)::int FROM issue_label WHERE issue_id = ${issueId}) AS labels,
      (SELECT count(*)::int FROM issue_activity WHERE issue_id = ${issueId}) AS activity,
      (SELECT count(*)::int FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE project_id = ${projectId}) AND event_type = 'issue.label_changed') AS label_events,
      (SELECT count(*)::int FROM issue_status WHERE issue_id = ${issueId}) AS status,
      (SELECT count(*)::int FROM issue_watcher WHERE issue_id = ${issueId}) AS watchers,
      (SELECT count(*)::int FROM notification WHERE issue_id = ${issueId}) AS notifications,
      (SELECT count(*)::int FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE project_id = ${projectId})) AS deliveries,
      (SELECT count(*)::int FROM agent_run WHERE issue_id = ${issueId}) AS runs,
      (SELECT actor_user_id FROM issue_activity WHERE issue_id = ${issueId} AND action = 'created' LIMIT 1) AS activity_actor,
      (SELECT actor_user_id FROM notification WHERE issue_id = ${issueId} LIMIT 1) AS notification_actor`);
}

describe('the gated create transaction', () => {
  // Before anything is removed: every fixture project holds exactly the issues its case declared. A
  // count above the expectation is a create that committed an issue nobody tracked.
  afterEach(async () => {
    const projects = fixtureProjects.splice(0);
    try {
      for (const project of projects) {
        expect([project.id, await issuesIn(project.id)]).toEqual([
          project.id,
          project.expectedIssues,
        ]);
      }
    } finally {
      // A failing check above must still leave the board clean and the cleanup attempts recorded.
      await cleanUp();
    }
  });

  it('allows a compliant create and queues each side effect exactly once', async () => {
    const f = await createFixture(true);
    const before = await board(f.projectId, f.rigId);
    const created = await withOwner(() => create(f, 'Atomic allow path'));
    const after = await board(f.projectId, f.rigId);
    const row = await facts(created, f.projectId);
    if (row.bead_id) minted.push(row.bead_id);

    // The identity and title come from the allocator, never from the caller's bytes.
    expect(row.bead_id).toBe(`${RIG_PREFIX}-${before.root}`);
    expect(row.title).toBe(`${before.root}: Atomic allow path`);
    // Each owned row the create is responsible for exists once: two labels, one status stretch, the
    // author and the assignee as watchers, one notification to the assignee, one webhook delivery and
    // one queued agent run because a delegate agent exists. The initial labels travel in the
    // issue.created payload, so there is no separate label_changed event to double them.
    expect([
      row.labels,
      row.status,
      row.watchers,
      row.notifications,
      row.deliveries,
      row.runs,
    ]).toEqual([2, 1, 2, 1, 1, 1]);
    expect(row.activity).toBeGreaterThanOrEqual(1);
    expect(row.label_events).toBe(0);
    // The actor the caller passed is the one both side-effect doors recorded.
    expect(row.activity_actor).toBe(f.authorId);
    expect(row.notification_actor).toBe(f.authorId);
    // Exactly one create reached the board, on whichever branch ran it. Same-transaction visibility is
    // not claimed here: the late-failure case below is the case that can distinguish the two.
    expect(after.seq).toBe(before.seq + 1);
    expect(after.root).toBe(before.root + 1);
    expect(after.issues).toBe(before.issues + 1);
    expect(after.identities).toBe(before.identities + 1);
    expect(after.labels).toBe(before.labels + 2);
    expect(after.status).toBe(before.status + 1);
    expect(after.watchers).toBe(before.watchers + 2);
    expect(after.notifications).toBe(before.notifications + 1);
    expect(after.deliveries).toBe(before.deliveries + 1);
    expect(after.runs).toBe(before.runs + 1);
  }, 120_000);

  it('rolls the whole create back when a late queue insert fails', async () => {
    const f = await createFixture(true, 0);
    const before = await board(f.projectId, f.rigId);
    const early = `u3c4 early missing ${Date.now()}`;
    const late = `u3c4 late create failure ${Date.now()}`;
    let failure: unknown = null;
    await withLateFailure(f.projectId, { early, late }, async () => {
      await withOwner(() => create(f, 'Atomic late failure')).catch((error: unknown) => {
        failure = error;
      });
    });

    // The await never returns, and the trigger reached its late marker rather than its early one: the
    // issue, labels, status stretch, watcher, activity and delivery were visible to that insert on the
    // create's own transaction before it was aborted.
    const chain = causeChain(failure);
    expect(chain).toContain(late);
    expect(chain).not.toContain(early);
    // This equality is the discriminating assertion: identity, sequence, issue, labels, history,
    // watchers, deliveries, the agent run and the failing notification are all back where they were,
    // and the rig counter and the ledger did not move. A post-commit implementation cannot pass it,
    // because its issue, identity and sequence would already have committed before the late insert.
    expect(await board(f.projectId, f.rigId)).toEqual(before);
    expect(await issuesIn(f.projectId)).toBe(0);
    const ledger = await one<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM bead_identity WHERE rig_id = ${f.rigId}`,
    );
    expect(ledger.n).toBe(before.identities);
  }, 120_000);

  it('keeps an ordinary project committed when its post-commit inbox insert fails', async () => {
    // The ordinary branch keeps its existing shape: the issue commits, then the side effects run on the
    // default pool. This case pins the consequence - a failing INBOX insert rejects the call and the
    // issue, its sequence and its labels stay committed, with no identity - which is a different
    // contract from the outbound-delivery best-effort behavior already covered by the outbound suite.
    const f = await createFixture(false);
    const before = await board(f.projectId, f.rigId);
    const early = `u3c4 ordinary early ${Date.now()}`;
    const late = `u3c4 ordinary inbox failure ${Date.now()}`;
    let failure: unknown = null;
    await withLateFailure(f.projectId, { early, late }, async () => {
      await create(f, 'Ordinary inbox failure').catch((error: unknown) => {
        failure = error;
      });
    });

    expect(causeChain(failure)).toContain(late);
    const after = await board(f.projectId, f.rigId);
    // The create itself committed; only the notification that failed is absent.
    expect(after.seq).toBe(before.seq + 1);
    expect(after.issues).toBe(before.issues + 1);
    expect(after.identities).toBe(before.identities);
    expect(after.labels).toBe(before.labels + 2);
    expect(after.status).toBe(before.status + 1);
    expect(after.notifications).toBe(before.notifications);
    // The issue the failing call left behind is found by its project and registered for cleanup.
    const left = await one<{ id: number }>(
      sql`SELECT id FROM issue WHERE project_id = ${f.projectId} AND title = 'Ordinary inbox failure'`,
    );
    expect(left).toBeDefined();
    made.issue.push(left.id);
  }, 120_000);

  it("keeps an ordinary project's post-commit behavior and writes no identity", async () => {
    const f = await createFixture(false);
    const before = await board(f.projectId, f.rigId);
    const created = await create(f, 'Ordinary path');
    const after = await board(f.projectId, f.rigId);
    const row = await facts(created, f.projectId);

    // No rig means no allocation: the title is the caller's own bytes and no ledger row exists.
    expect(row.bead_id).toBeNull();
    expect(row.title).toBe('Ordinary path');
    expect([row.labels, row.status, row.watchers, row.runs]).toEqual([2, 1, 2, 1]);
    expect([after.issues, after.identities]).toEqual([before.issues + 1, before.identities]);
    expect(after.seq).toBe(before.seq + 1);
    expect(after.deliveries).toBe(before.deliveries + 1);
  }, 120_000);

  it('retains only the fixture the schema forbids removing', async () => {
    // Root's fixture ruling: one named synthetic rig and the tombstones its gated creates minted, with
    // every other owned row removed by exact id and every cleanup attempt accounted for.
    expect(cleanupErrors).toEqual([]);
    const keep = await retained();
    expect(keep.rig.prefix).toBe(RIG_PREFIX);
    const local = minted.map((token) => token.slice(RIG_PREFIX.length + 1)).sort();
    expect(keep.ledger.map((entry) => entry.local_token)).toEqual(local);
    expect(keep.ledger.map((entry) => entry.issue_id)).toEqual(local.map(() => null));
    expect(keep.ledger.map((entry) => entry.origin)).toEqual(local.map(() => 'minted'));
    expect(keep.rig.next_root).toBe(local.filter((token) => !token.includes('.')).length + 1);
    expect(made.rig.length).toBe(1);
    // Nothing this run ever made is still standing, by exact id, after the cleanups ran.
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
  }, 60_000);
});
