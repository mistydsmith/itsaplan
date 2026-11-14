import { afterEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';

// The gated UPDATE writer, end to end. The allow case shows each side effect queued exactly once, which
// the current post-commit writer can also satisfy because the counts are read after the call; it is NOT
// discriminating. Only the late-failure case is: its board equality can pass only if the sequence ran on
// the update transaction. The fixture module is synthetic rows and readback only: no app mock, no
// stubbed gate, no exported test seam.
//
// DATABASE HELD: the fixture guard refuses before any client exists unless Root set the grant flag on
// the serial DB GO. This file is prepared source and is not run until that GO.
import {
  board,
  causeChain,
  cleanUp,
  cleanupErrors,
  fixtureProjects,
  made,
  minted,
  one,
  residue,
  retained,
  RIG_PREFIX,
  updateFixture,
  withLateStateFailure,
  withOwner,
} from './tracker-update-atomicity-fixtures';
import type { UpdateFixture } from './tracker-update-atomicity-fixtures';

const { updateIssue } = await import('../../service');

// What the caller asked for in the allow and late-failure cases: a move between two non-terminal
// columns, a new title, a description that mentions one member, and a cycle the issue joins.
function patchFor(f: UpdateFixture, suffix: string) {
  // The identity rule judges a gated title against the ledger token, so a gated title carries it. An
  // ordinary project has no token and keeps the plain title.
  const title = f.rigId === null ? `edited ${suffix}` : `${f.localToken}: edited ${suffix}`;
  return {
    columnId: f.doingId,
    title,
    description: `edited ${suffix} for @${f.mentionHandle}`,
    cycleId: f.cycleId,
  };
}

async function runsFor(issueId: number) {
  return one<{
    runs: number;
    prompt: string | null;
    trigger: string | null;
    schedule: number | null;
  }>(sql`
    SELECT count(*)::int AS runs, min(prompt) AS prompt, min(trigger) AS trigger, min(schedule_id) AS schedule
    FROM agent_run WHERE issue_id = ${issueId}`);
}

describe('the gated update transaction', () => {
  // Before cleanup: each fixture project holds exactly the issues its case declared, so a create or a
  // cascaded edit that committed an untracked row is caught even if the case never saw it.
  afterEach(async () => {
    const projects = fixtureProjects.splice(0);
    try {
      for (const project of projects) {
        const row = await one<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM issue WHERE project_id = ${project.id}`,
        );
        expect([project.id, row.n]).toEqual([project.id, project.expectedIssues]);
      }
    } finally {
      await cleanUp();
    }
  });

  it('queues each side effect of a compliant move exactly once', async () => {
    const f = await updateFixture(true, 'allow');
    const before = await board(f.projectId, f.issueId, f.rigId);
    const suffix = `allow-${Date.now()}`;
    const updated = await withOwner(() => updateIssue(f.issueId, patchFor(f, suffix), f.actorId));
    const after = await board(f.projectId, f.issueId, f.rigId);

    // The returned row is the readback, not a stale snapshot.
    const expectedTitle = `${f.localToken}: edited ${suffix}`;
    expect(updated!.title).toBe(expectedTitle);
    expect(updated!.columnId).toBe(f.doingId);
    expect(after.title).toBe(expectedTitle);
    expect(after.column).toBe(f.doingId);
    expect(after.cycle).toBe(f.cycleId);
    // The move closed the old stretch and opened exactly one new one; the edit logged its activity. Two
    // notifications: one to the non-actor watcher for the status change and one for the mention. Both
    // events queued one delivery, the cycle row was written, and exactly one status run was queued with
    // the target column's own wording.
    expect([after.stretches, after.open_stretches]).toEqual([before.stretches + 1, 1]);
    expect(after.activity).toBeGreaterThan(before.activity);
    expect(after.notifications).toBe(before.notifications + 2);
    expect([after.deliveries_updated, after.deliveries_state]).toEqual([
      before.deliveries_updated + 1,
      before.deliveries_state + 1,
    ]);
    expect(after.cycle_rows).toBe(before.cycle_rows + 1);
    expect(after.runs).toBe(before.runs + 1);
    const runs = await runsFor(f.issueId);
    expect([runs.runs, runs.trigger]).toEqual([1, 'status']);
    expect(runs.prompt).toContain('entered the "Doing" status');
    expect(runs.schedule).not.toBeNull();
    // An edit allocates no identity and moves no rig counter.
    expect([after.identities, after.root]).toEqual([before.identities, before.root]);
    expect(after.seq).toBe(before.seq);
  }, 120_000);

  it('rolls the whole edit back when a late queue insert fails', async () => {
    const f = await updateFixture(true, 'late');
    const before = await board(f.projectId, f.issueId, f.rigId);
    const early = `u3c4 update early ${Date.now()}`;
    const late = `u3c4 update late ${Date.now()}`;
    let failure: unknown = null;
    await withLateStateFailure(f.projectId, f.doingId, { early, late }, async () => {
      await withOwner(() =>
        updateIssue(f.issueId, patchFor(f, `late-${Date.now()}`), f.actorId),
      ).catch((error: unknown) => {
        failure = error;
      });
    });

    // The trigger reached its LATE marker, not its EARLY one: the written row and every earlier side
    // effect were visible to that insert on the update's own transaction.
    const chain = causeChain(failure);
    expect(chain).toContain(late);
    expect(chain).not.toContain(early);
    // The whole board is back: column, title, description, cycle, updated_at, the stretch it had already
    // closed, activity, notifications, both deliveries, the cycle row, the status run and the counters.
    expect(await board(f.projectId, f.issueId, f.rigId)).toEqual(before);
    const runs = await runsFor(f.issueId);
    expect(runs.runs).toBe(0);
  }, 120_000);

  it('keeps an ordinary project committed when its post-commit queue insert fails', async () => {
    // The ordinary branch has no transaction of its own around the side effects, so this pins the
    // existing post-commit contract: the UPDATE stays committed and only the failing delivery is absent.
    const f = await updateFixture(false, 'ordinary');
    const before = await board(f.projectId, f.issueId, f.rigId);
    const early = `u3c4 ordinary early ${Date.now()}`;
    const late = `u3c4 ordinary late ${Date.now()}`;
    const suffix = `ordinary-${Date.now()}`;
    let failure: unknown = null;
    await withLateStateFailure(f.projectId, f.doingId, { early, late }, async () => {
      await withOwner(() => updateIssue(f.issueId, patchFor(f, suffix), f.actorId)).catch(
        (error: unknown) => {
          failure = error;
        },
      );
    });

    expect(causeChain(failure)).toContain(late);
    const after = await board(f.projectId, f.issueId, f.rigId);
    // Committed: the move, the title, the cycle and the closed/opened stretch are all in place, and the
    // issue.updated delivery was already queued. The state_changed delivery is the insert that failed,
    // and the status run behind it never ran.
    expect([after.column, after.title, after.cycle]).toEqual([
      f.doingId,
      `edited ${suffix}`,
      f.cycleId,
    ]);
    expect([after.stretches, after.open_stretches]).toEqual([before.stretches + 1, 1]);
    expect(after.deliveries_updated).toBe(before.deliveries_updated + 1);
    expect(after.deliveries_state).toBe(before.deliveries_state);
    expect(after.runs).toBe(before.runs);
  }, 120_000);

  it('writes nothing on the two gated no-write paths', async () => {
    const f = await updateFixture(true, 'nowrite');
    const before = await board(f.projectId, f.issueId, f.rigId);

    // onlyIfColumnId names a column this issue is not in: the write is dropped and the current row comes
    // back with no side effect written. Skipping the owner call entirely is the update-atomicity unit's
    // requirement to implement; today the gate still runs and the guarded UPDATE drops the write.
    const mismatch = await withOwner(() =>
      updateIssue(f.issueId, patchFor(f, 'mismatch'), f.actorId, { onlyIfColumnId: f.doneId }),
    );
    expect(mismatch!.columnId).toBe(f.todoId);
    expect(await board(f.projectId, f.issueId, f.rigId)).toEqual(before);

    // A full target column with skipIfColumnFull: the breach is measured, the write is skipped and the
    // current row is returned. The second issue fills the column, which is the only way to make it full.
    const fill = await withOwner(() =>
      (async () => {
        const { createIssue } = await import('../../service');
        const { getProjectById } = await import('../../../projects/service');
        const projectRow = await getProjectById(f.projectId);
        // The gated create needs the size label, and this create also queues one status run for the
        // occupant because it is made straight into the scheduled column.
        return createIssue(
          projectRow!,
          { columnId: f.doingId, title: 'occupant', labelIds: [f.sizeLabelId] },
          f.actorId,
        );
      })(),
    );
    made.issue.push(fill.id);
    const identity = await one<{ bead_id: string | null }>(
      sql`SELECT bead_id FROM issue WHERE id = ${fill.id}`,
    );
    if (identity.bead_id) minted.push(identity.bead_id);
    fixtureProjects[fixtureProjects.length - 1].expectedIssues = 2;
    // wipLimitBreach answers null unless the column's mode is hard, so the limit alone would let the
    // write through and the skip case would silently stop testing anything.
    await one(
      sql`UPDATE project_column SET wip_limit = 1, wip_mode = 'hard' WHERE id = ${f.doingId} RETURNING id`,
    );
    const fullBefore = await board(f.projectId, f.issueId, f.rigId);
    const skipped = await withOwner(() =>
      updateIssue(f.issueId, patchFor(f, 'full'), f.actorId, { skipIfColumnFull: true }),
    );
    expect(skipped!.columnId).toBe(f.todoId);
    expect(await board(f.projectId, f.issueId, f.rigId)).toEqual(fullBefore);
  }, 120_000);

  it('refuses a move into a terminal column under the current owner policy', async () => {
    const f = await updateFixture(true, 'close');
    const before = await board(f.projectId, f.issueId, f.rigId);
    let refusal: { status?: number; message?: string } = {};
    await withOwner(() =>
      updateIssue(f.issueId, { columnId: f.doneId }, f.actorId).catch((error: unknown) => {
        const http = error as { status?: number; message?: string };
        refusal = { status: http.status, message: http.message };
      }),
    );
    // Close moves carry no authenticated close facts yet, so the owner refuses them: the refusal is the
    // existing 409 mapping and the board did not move.
    expect(refusal.status).toBe(409);
    expect(refusal.message ?? '').toContain('close');
    expect(await board(f.projectId, f.issueId, f.rigId)).toEqual(before);
  }, 120_000);

  it('retains only the fixture the schema forbids removing', async () => {
    expect(cleanupErrors).toEqual([]);
    const keep = await retained();
    expect(keep.rig.prefix).toBe(RIG_PREFIX);
    const local = minted.map((token) => token.slice(RIG_PREFIX.length + 1)).sort();
    expect(keep.ledger.map((entry) => entry.local_token)).toEqual(local);
    expect(keep.ledger.map((entry) => entry.issue_id)).toEqual(local.map(() => null));
    expect(keep.ledger.map((entry) => entry.origin)).toEqual(local.map(() => 'minted'));
    expect(keep.rig.next_root).toBe(local.filter((token) => !token.includes('.')).length + 1);
    expect(await residue()).toEqual({
      issues: 0,
      agents: 0,
      cycles: 0,
      schedules: 0,
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
