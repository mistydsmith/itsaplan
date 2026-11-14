import { afterAll, beforeAll, expect, it } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '@repo/db';

// Real-TX integration test for the scheduled issue-run connector (8364 D2): queueStatusRuns /
// queueScheduleRuns / hasUnfinishedStatusRuns take a trailing executor, so every read and write
// of one queueing call stays in the caller's transaction; the extension IssueFilter takes the
// same executor, so a filter that reads the board sees uncommitted state. Self-contained
// fixtures (no reset / migration / provider). The exact-target / NODE_ENV / no-worker guard
// runs BEFORE any DB import; the db handle and code under test are imported after it.

const EXPECTED_DB = 'itsaplan_8364_d2_test';
function assertTargetGuard(): void {
  const envUrl = process.env.DATABASE_URL ?? '';
  let u: URL;
  try {
    u = new URL(envUrl);
  } catch {
    throw new Error(
      `target guard: DATABASE_URL is not a parseable URL, got ${JSON.stringify(envUrl)}`,
    );
  }
  if (u.hostname !== '127.0.0.1' && u.hostname !== '::1') {
    throw new Error(`target guard: host must be loopback (127.0.0.1 or ::1), got '${u.hostname}'`);
  }
  if (u.port !== '5433') throw new Error(`target guard: port must be 5433, got '${u.port}'`);
  if (u.pathname !== `/${EXPECTED_DB}`) {
    throw new Error(`target guard: path must be /${EXPECTED_DB}, got '${u.pathname}'`);
  }
  if (process.env.NODE_ENV !== 'test') throw new Error('target guard: NODE_ENV must be test');
  if (process.env.BUN_TEST_WORKER_ID) {
    throw new Error('target guard: BUN_TEST_WORKER_ID must be unset (single process)');
  }
}
assertTargetGuard();

// Lowercase hex run suffix: safe in names/emails, unique per run so a rerun never collides.
const S = randomUUID().replace(/-/g, '');
type Ex = DbExecutor;
type IssueRunsMod = typeof import('../../issue-runs');
type ExtMod = typeof import('../../extension');
let db: Ex;
let queueStatusRuns: IssueRunsMod['queueStatusRuns'];
let queueScheduleRuns: IssueRunsMod['queueScheduleRuns'];
let hasUnfinishedStatusRuns: IssueRunsMod['hasUnfinishedStatusRuns'];
let setScheduleIssueFilter: ExtMod['setScheduleIssueFilter'];
let setScheduleTypes: ExtMod['setScheduleTypes'];
let isScheduleType: ExtMod['isScheduleType'];
let filterScheduleIssues: ExtMod['filterScheduleIssues'];

// Ids this run actually wrote; a field is set only after its insert returned.
const fx = {
  ws: 0,
  team: 0,
  proj: 0,
  colA: 0,
  colB: 0,
  agent: 0,
  agentUser: `sh-${S}`,
  statusA: 0,
  statusB: 0,
  ext: 0,
  paused: 0,
  webhook: 0,
};
const colNameA = `ColA-${S}`;
const projKey = `S${S}`;
const issueTitle = `TxIssue-${S}`;

async function insertId(executor: Ex, query: SQL): Promise<number> {
  const rows = (await executor.execute(query)) as unknown as Array<{ id: number | string }>;
  const id = Number(rows[0]?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('fixture insert returned no id');
  return id;
}
async function oneRow(executor: Ex, query: SQL): Promise<Record<string, unknown> | null> {
  const rows = (await executor.execute(query)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}
async function count(ex: Ex, table: string, filter: SQL) {
  const r = await oneRow(ex, sql`select count(*)::int as n from ${sql.raw(table)} where ${filter}`);
  return Number(r?.n ?? 0);
}
async function runStatus(ex: Ex, id: number): Promise<string> {
  return String((await oneRow(ex, sql`select status from agent_run where id = ${id}`))?.status);
}
async function lastRunAt(ex: Ex, sid: number): Promise<unknown> {
  return (await oneRow(ex, sql`select last_run_at lr from agent_schedule where id = ${sid}`))?.lr;
}

// A per-case uncommitted issue on colB with a unique per-project sequence.
async function makeIssue(tx: Ex): Promise<number> {
  const seq = 1000 + Math.floor(Math.random() * 89999);
  return insertId(
    tx,
    sql`insert into issue (project_id, sequence_number, column_id, title)
        values (${fx.proj}, ${seq}, ${fx.colB}, ${issueTitle}) returning id`,
  );
}

// Run the body on a fresh transaction and force it to roll back; body failures propagate after.
async function withTx(body: (tx: Ex) => Promise<void>): Promise<void> {
  let failure: unknown = null;
  try {
    await db.transaction(async (tx) => {
      await body(tx as Ex);
      throw new Error('sched-abort'); // force the rollback once the body has asserted
    });
  } catch (e) {
    if ((e as Error).message === 'sched-abort') return;
    failure = e;
  }
  if (failure) throw failure;
}

// WHY the cause chain: drizzle wraps a driver failure whose message is only "Failed query:
// ..."; the Postgres text and SQLSTATE code are on .cause. The walk stops at a repeated link.
function hasPgError(error: unknown, code: string, message: RegExp): boolean {
  const seen = new Set<unknown>();
  let link = error;
  while (link instanceof Error && !seen.has(link)) {
    seen.add(link);
    if ((link as { code?: unknown }).code === code && message.test(link.message)) return true;
    link = (link as { cause?: unknown }).cause;
  }
  return false;
}

beforeAll(async () => {
  ({ db } = await import('@repo/db'));
  ({ queueStatusRuns, queueScheduleRuns, hasUnfinishedStatusRuns } =
    await import('../../issue-runs'));
  const ext = await import('../../extension');
  ({ setScheduleIssueFilter, setScheduleTypes, isScheduleType, filterScheduleIssues } = ext);
  setScheduleTypes(['sched_ext']); // this run's extension type, so the ext schedule is supported
  const wsName = `Sched ${S}`;
  fx.ws = await insertId(db, sql`insert into workspace (name) values (${wsName}) returning id`);
  fx.team = await insertId(
    db,
    sql`insert into team (workspace_id, name) values (${fx.ws}, ${`Sched T ${S}`}) returning id`,
  );
  fx.proj = await insertId(
    db,
    sql`insert into project (team_id, "key", name) values (${fx.team}, ${projKey}, ${`Sched P ${S}`}) returning id`,
  );
  fx.colA = await insertId(
    db,
    sql`insert into project_column (project_id, name, position) values (${fx.proj}, ${colNameA}, 1) returning id`,
  );
  fx.colB = await insertId(
    db,
    sql`insert into project_column (project_id, name, position) values (${fx.proj}, 'ColB', 2) returning id`,
  );
  await db.execute(
    sql`insert into "user" (id, name, email, email_verified, username) values (${fx.agentUser}, 'SH', ${`${fx.agentUser}@scratch.test`}, true, ${fx.agentUser})`,
  );
  fx.agent = await insertId(
    db,
    sql`insert into ai_agent (team_id, user_id, username, kind) values (${fx.team}, ${fx.agentUser}, ${`sa-${S}`}, 'internal') returning id`,
  );
  fx.statusA = await insertId(
    db,
    sql`insert into agent_schedule (agent_id, project_id, name, prompt, type, timezone, column_id)
        values (${fx.agent}, ${fx.proj}, 'A', 'Review it', 'status', 'UTC', ${fx.colA}) returning id`,
  );
  fx.statusB = await insertId(
    db,
    sql`insert into agent_schedule (agent_id, project_id, name, prompt, type, timezone, column_id)
        values (${fx.agent}, ${fx.proj}, 'B', 'Review it', 'status', 'UTC', ${fx.colB}) returning id`,
  );
  fx.ext = await insertId(
    db,
    sql`insert into agent_schedule (agent_id, project_id, name, prompt, type, timezone)
        values (${fx.agent}, ${fx.proj}, 'E', 'Extend it', 'sched_ext', 'UTC') returning id`,
  );
  fx.paused = await insertId(
    db,
    sql`insert into agent_schedule (agent_id, project_id, name, prompt, type, timezone, status)
        values (${fx.agent}, ${fx.proj}, 'P', 'Extend it', 'sched_ext', 'UTC', 'paused') returning id`,
  );
  fx.webhook = await insertId(
    db,
    sql`insert into webhook (project_id, url, secret, events, is_active)
        values (${fx.proj}, 'https://s.scratch.test/h', 's', '["agent_run.finished"]'::jsonb, true) returning id`,
  );
});

afterAll(async () => {
  // Restore globals, then clean up; asserts run after cleanup so a failure never skips the cleanup.
  setScheduleTypes([]);
  setScheduleIssueFilter();
  const cleanupErrors: unknown[] = [];
  for (const q of [
    sql`delete from agent_run where project_id = ${fx.proj}`,
    sql`delete from webhook_delivery where webhook_id = ${fx.webhook}`,
    sql`delete from agent_schedule where id in (${fx.statusA}, ${fx.statusB}, ${fx.ext}, ${fx.paused})`,
    sql`delete from issue where project_id = ${fx.proj}`,
    sql`delete from project_column where id in (${fx.colA}, ${fx.colB})`,
    sql`delete from ai_agent where id = ${fx.agent}`,
    sql`delete from project where id = ${fx.proj}`,
    sql`delete from team where id = ${fx.team}`,
    sql`delete from workspace where id = ${fx.ws}`,
    sql`delete from "user" where id = ${fx.agentUser}`,
  ]) {
    try {
      await db.execute(q);
    } catch (e) {
      cleanupErrors.push(e);
    }
  }
  expect(isScheduleType('sched_ext')).toBe(false); // restore held
  expect(
    await filterScheduleIssues(
      { id: 1, agentId: 1, projectId: 1, type: 'status', options: {} },
      [7],
    ),
  ).toEqual([7]);
  expect(cleanupErrors).toEqual([]); // every exact-key delete succeeded
  expect(await count(db, 'workspace', sql`id = ${fx.ws}`)).toBe(0); // and nothing is left behind
  expect(await count(db, 'team', sql`id = ${fx.team}`)).toBe(0);
  expect(await count(db, 'project', sql`id = ${fx.proj}`)).toBe(0);
  expect(await count(db, 'project_column', sql`id in (${fx.colA}, ${fx.colB})`)).toBe(0);
  expect(await count(db, 'ai_agent', sql`id = ${fx.agent}`)).toBe(0);
  expect(await count(db, '"user"', sql`id = ${fx.agentUser}`)).toBe(0);
});

it('cancels a pending run with its delivery on the same tx and undoes it all on abort', async () => {
  let oldRun = 0;
  await withTx(async (tx) => {
    const issueId = await makeIssue(tx);
    oldRun = await insertId(
      tx,
      sql`insert into agent_run (project_id, agent_id, issue_id, schedule_id, trigger, prompt, status, attempts)
          values (${fx.proj}, ${fx.agent}, ${issueId}, ${fx.statusB}, 'status', 'old run', 'pending', 0) returning id`,
    );
    await queueStatusRuns([issueId], fx.colA, null, tx);
    expect(await runStatus(tx, oldRun)).toBe('canceled');
    expect(await count(tx, 'webhook_delivery', sql`webhook_id = ${fx.webhook}`)).toBe(1);
    expect(await count(tx, 'agent_run', sql`issue_id = ${issueId}`)).toBe(2); // old canceled + new pending
    expect(await count(tx, 'agent_run', sql`issue_id = ${issueId} and status = 'pending'`)).toBe(1);
    expect(await lastRunAt(tx, fx.statusA)).not.toBeNull();
    expect(await hasUnfinishedStatusRuns(fx.colA, tx)).toBe(true);
  });
  // Forced abort: the pool must see none of it, and the schedule back to no last_run_at.
  expect(await oneRow(db, sql`select id from agent_run where id = ${oldRun}`)).toBeNull();
  expect(await count(db, 'webhook_delivery', sql`webhook_id = ${fx.webhook}`)).toBe(0);
  expect(await lastRunAt(db, fx.statusA)).toBeNull();
  expect(await hasUnfinishedStatusRuns(fx.colA)).toBe(false);
});

it('resolves real uncommitted issue facts into the exact queued prompt on the tx', async () => {
  const marker = `TxP-${S}`;
  await withTx(async (tx) => {
    const issueId = await makeIssue(tx);
    // Tx-only prompt marker: the queued run must read it through the tx, proving the schedule
    // SELECT runs on the caller's executor; rollback restores the original prompt.
    await tx.execute(sql`update agent_schedule set prompt = ${marker} where id = ${fx.statusA}`);
    await queueStatusRuns([issueId], fx.colA, null, tx);
    const r = await oneRow(
      tx,
      sql`select prompt, trigger from agent_run where issue_id = ${issueId} and schedule_id = ${fx.statusA}`,
    );
    // identifier = project.key || '-' || sequence_number, read from the uncommitted issue row.
    expect(String(r?.trigger)).toBe('status');
    expect(String(r?.prompt).startsWith(`Work item ${projKey}-`)).toBe(true);
    expect(String(r?.prompt)).toContain(`"${issueTitle}" entered the "${colNameA}" status.`);
    expect(String(r?.prompt).endsWith(`status.\n\n${marker}`)).toBe(true);
  });
  expect(
    String(
      (await oneRow(db, sql`select prompt from agent_schedule where id = ${fx.statusA}`))?.prompt,
    ),
  ).toBe('Review it');
});

it('excludes the actor and skips unsupported or paused schedules unchanged on the tx', async () => {
  await withTx(async (tx) => {
    const issueId = await makeIssue(tx);
    // The actor is the agent's own user: none of its schedules may start.
    await queueScheduleRuns([fx.ext], [issueId], fx.agentUser, (r) => `lead ${r.identifier}`, tx);
    expect(await count(tx, 'agent_run', sql`issue_id = ${issueId}`)).toBe(0);
    // Only the active extension schedule queues a run here (status and paused ones are skipped).
    await queueScheduleRuns(
      [fx.statusA, fx.paused, fx.ext],
      [issueId],
      null,
      (r) => `lead ${r.identifier}`,
      tx,
    );
    const rows = (await tx.execute(
      sql`select trigger, schedule_id from agent_run where issue_id = ${issueId} order by id`,
    )) as unknown as Array<{ trigger: string; schedule_id: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0].trigger).toBe('event');
    expect(rows[0].schedule_id).toBe(fx.ext);
  });
});

it('forwards the supplied executor to the filter and keeps two-argument callbacks working', async () => {
  let seen: Ex | undefined;
  setScheduleIssueFilter(async (_s, issueIds: number[], ex?: Ex) => {
    seen = ex;
    return issueIds;
  });
  try {
    await withTx(async (tx) => {
      const issueId = await makeIssue(tx);
      await queueScheduleRuns([fx.ext], [issueId], null, (r) => `lead ${r.identifier}`, tx);
      expect(seen).toBe(tx); // the filter saw the caller's transaction, not the pool
      expect(await count(tx, 'agent_run', sql`issue_id = ${issueId}`)).toBe(1);
    });
  } finally {
    setScheduleIssueFilter(); // restore the default before the pool case below
  }
  // A two-argument callback (written pre-executor) still works on the default pool path.
  let calls = 0;
  setScheduleIssueFilter(async (_s, issueIds: number[]) => {
    calls += 1;
    return issueIds;
  });
  try {
    const issueId = await makeIssue(db);
    await queueScheduleRuns([fx.ext], [issueId], null, (r) => `lead ${r.identifier}`);
    expect(calls).toBe(1);
    expect(await count(db, 'agent_run', sql`issue_id = ${issueId}`)).toBe(1);
    await db.execute(sql`delete from agent_run where issue_id = ${issueId}`);
    await db.execute(sql`delete from issue where id = ${issueId}`);
    await db.execute(sql`update agent_schedule set last_run_at = null where id = ${fx.ext}`);
  } finally {
    setScheduleIssueFilter();
  }
});

it('propagates an actual insert failure before the awaited return, with the cause chain and no residue', async () => {
  const fn = `sched_fn_${S}`;
  const trg = `sched_trg_${S}`;
  let caught: unknown = null;
  await withTx(async (tx) => {
    const issueId = await makeIssue(tx);
    // The pending run makes cancel + delivery run before the blocked insert: both must roll back.
    await tx.execute(
      sql`insert into agent_run (project_id, agent_id, issue_id, schedule_id, trigger, prompt, status, attempts)
          values (${fx.proj}, ${fx.agent}, ${issueId}, ${fx.statusB}, 'status', 'old run', 'pending', 0)`,
    );
    // An owned trigger on the same tx blocks the queued insert; the forced abort drops it.
    await tx.execute(
      sql.raw(
        `create function ${fn}() returns trigger as $$ begin if new.schedule_id = ${fx.statusA} then ` +
          `raise exception 'MARKER_SCHED_RUN_INSERT_BLOCKED'; end if; return new; end; $$ language plpgsql`,
      ),
    );
    await tx.execute(
      sql.raw(
        `create trigger ${trg} before insert on agent_run for each row execute function ${fn}()`,
      ),
    );
    try {
      await queueStatusRuns([issueId], fx.colA, null, tx);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull(); // the failure propagated before the awaited return
    expect(hasPgError(caught, 'P0001', /MARKER_SCHED_RUN_INSERT_BLOCKED/)).toBe(true); // cause chain
  });
  expect(await count(db, 'webhook_delivery', sql`webhook_id = ${fx.webhook}`)).toBe(0); // gone
  expect(await lastRunAt(db, fx.statusA)).toBeNull();
  expect(await hasUnfinishedStatusRuns(fx.colA)).toBe(false);
});

it('keeps the default path on the pool: the call commits without an executor', async () => {
  const issueId = await insertId(
    db,
    sql`insert into issue (project_id, sequence_number, column_id, title)
        values (${fx.proj}, ${1000 + Math.floor(Math.random() * 89999)}, ${fx.colB}, ${issueTitle}) returning id`,
  );
  const oldRun = await insertId(
    db,
    sql`insert into agent_run (project_id, agent_id, issue_id, schedule_id, trigger, prompt, status, attempts)
        values (${fx.proj}, ${fx.agent}, ${issueId}, ${fx.statusB}, 'status', 'old run', 'pending', 0) returning id`,
  );
  await queueStatusRuns([issueId], fx.colA, null); // no executor: the pool
  expect(await runStatus(db, oldRun)).toBe('canceled');
  const r = await oneRow(
    db,
    sql`select trigger, prompt from agent_run where issue_id = ${issueId} and schedule_id = ${fx.statusA}`,
  );
  expect(r?.trigger).toBe('status');
  expect(String(r?.prompt)).toContain(`entered the "${colNameA}" status.`);
  expect(await count(db, 'webhook_delivery', sql`webhook_id = ${fx.webhook}`)).toBe(1); // committed
  expect(await lastRunAt(db, fx.statusA)).not.toBeNull();
  // Exact-key cleanup of this committed case.
  await db.execute(
    sql`delete from agent_run where id in (${oldRun}, ${Number((await oneRow(db, sql`select id from agent_run where issue_id = ${issueId} and schedule_id = ${fx.statusA}`))?.id)})`,
  );
  await db.execute(sql`delete from webhook_delivery where webhook_id = ${fx.webhook}`);
  await db.execute(sql`delete from issue where id = ${issueId}`);
  await db.execute(sql`update agent_schedule set last_run_at = null where id = ${fx.statusA}`);
});
