import { afterAll, beforeAll, expect, it } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '@repo/db';

// Real-TX integration test for the parent-change activity connector (8364 D2): identifiers /
// recordParentChange take a trailing executor, so the issue/project name SELECT and the
// activity INSERTs of one parent change stay in the caller's transaction. Self-contained
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
let db: Ex;
let recordParentChange: typeof import('../../service').recordParentChange;

// Ids this run actually wrote; a field is set only after its insert returned.
const fx = {
  ws: 0,
  team: 0,
  proj: 0,
  col: 0,
  actorUser: `PhU-${S}`,
  issues: [] as number[],
};
const wsName = `PhWS ${S}`;
const teamName = `PhTeam ${S}`;
const projKey = `PhK${S}`;
const projName = `PhProj ${S}`;
const colName = `PhCol ${S}`;
const actorName = `PhActor ${S}`;
// Monotonic per-run counter: the issues of one project always get distinct sequences
// (random draws can collide, ~1 in 30,000 per case).
let seqCounter = 1000;

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
function payloadOf(row: Record<string, unknown>): Record<string, unknown> {
  const p = row.payload;
  return (typeof p === 'string' ? JSON.parse(p) : p) as Record<string, unknown>;
}
function sideOf(
  p: Record<string, unknown>,
  key: 'from' | 'to',
): Record<string, unknown> | undefined {
  const v = p[key];
  return v == null
    ? undefined
    : ((typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>);
}
// The one activity row of (issue, action); a parent change writes at most one per pair.
async function act(
  ex: Ex,
  issueId: number,
  action: string,
): Promise<Record<string, unknown> | null> {
  return oneRow(
    ex,
    sql`select issue_id, action, payload, actor_user_id, actor_name
        from issue_activity where issue_id = ${issueId} and kind = 'activity' and action = ${action}`,
  );
}
async function actCount(ex: Ex, issueId: number): Promise<number> {
  return count(ex, 'issue_activity', sql`issue_id = ${issueId} and kind = 'activity'`);
}
// A unique per-project sequence; the identifier is the project key plus this number.
async function makeIssueTx(tx: Ex): Promise<{ id: number; seq: number }> {
  const seq = ++seqCounter;
  const id = await insertId(
    tx,
    sql`insert into issue (project_id, sequence_number, column_id, title)
        values (${fx.proj}, ${seq}, ${fx.col}, ${`PhTx ${S}`}) returning id`,
  );
  fx.issues.push(id);
  return { id, seq };
}

// Run the body on a fresh transaction and force it to roll back; body failures propagate after.
async function withTx(body: (tx: Ex) => Promise<void>): Promise<void> {
  let failure: unknown = null;
  try {
    await db.transaction(async (tx) => {
      await body(tx as Ex);
      throw new Error('ph-abort'); // force the rollback once the body has asserted
    });
  } catch (e) {
    if ((e as Error).message === 'ph-abort') return;
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
  ({ recordParentChange } = await import('../../service'));
  fx.ws = await insertId(db, sql`insert into workspace (name) values (${wsName}) returning id`);
  fx.team = await insertId(
    db,
    sql`insert into team (workspace_id, name) values (${fx.ws}, ${teamName}) returning id`,
  );
  fx.proj = await insertId(
    db,
    sql`insert into project (team_id, "key", name) values (${fx.team}, ${projKey}, ${projName}) returning id`,
  );
  fx.col = await insertId(
    db,
    sql`insert into project_column (project_id, name, position) values (${fx.proj}, ${colName}, 1) returning id`,
  );
  await db.execute(
    sql`insert into "user" (id, name, email, email_verified, username)
        values (${fx.actorUser}, ${actorName}, ${`${fx.actorUser}@scratch.test`}, true, ${fx.actorUser})`,
  );
});

afterAll(async () => {
  // Clean up, collecting errors; the asserts run after cleanup so a failure never skips it.
  const cleanupErrors: unknown[] = [];
  const inList = sql.raw(fx.issues.length ? `(${fx.issues.join(',')})` : '(0)');
  for (const q of [
    sql`delete from issue_activity where issue_id in ${inList}`,
    sql`delete from issue where project_id = ${fx.proj}`,
    sql`delete from project_column where id = ${fx.col}`,
    sql`delete from project where id = ${fx.proj}`,
    sql`delete from team where id = ${fx.team}`,
    sql`delete from workspace where id = ${fx.ws}`,
    sql`delete from "user" where id = ${fx.actorUser}`,
  ]) {
    try {
      await db.execute(q);
    } catch (e) {
      cleanupErrors.push(e);
    }
  }
  expect(cleanupErrors).toEqual([]); // every exact-key delete succeeded
  expect(await count(db, 'workspace', sql`id = ${fx.ws}`)).toBe(0); // and nothing is left behind
  expect(await count(db, 'team', sql`id = ${fx.team}`)).toBe(0);
  expect(await count(db, 'project', sql`id = ${fx.proj}`)).toBe(0);
  expect(await count(db, 'project_column', sql`id = ${fx.col}`)).toBe(0);
  expect(await count(db, 'issue', sql`project_id = ${fx.proj}`)).toBe(0);
  expect(await count(db, 'issue_activity', sql`issue_id in ${inList}`)).toBe(0);
  expect(await count(db, '"user"', sql`id = ${fx.actorUser}`)).toBe(0);
});

it('writes the parent change feeds on the same tx with uncommitted names and undoes all on abort', async () => {
  let childId = 0;
  let beforeId = 0;
  let afterId = 0;
  await withTx(async (tx) => {
    const before = await makeIssueTx(tx);
    const after = await makeIssueTx(tx);
    const child = await makeIssueTx(tx);
    beforeId = before.id;
    afterId = after.id;
    childId = child.id;
    await recordParentChange(childId, beforeId, afterId, fx.actorUser, tx);
    // All three feeds are observable on the supplied tx, before the forced abort, and they
    // carry the uncommitted project-key/sequence names and the actor's name.
    const c = await act(tx, childId, 'parent');
    expect(String(c?.actor_user_id)).toBe(fx.actorUser);
    expect(String(c?.actor_name)).toBe(actorName);
    const cp = payloadOf(c ?? {});
    expect(sideOf(cp, 'from')).toEqual({ value: `${projKey}-${before.seq}`, id: beforeId });
    expect(sideOf(cp, 'to')).toEqual({ value: `${projKey}-${after.seq}`, id: afterId });
    const b = await act(tx, beforeId, 'subtask_remove');
    expect(sideOf(payloadOf(b ?? {}), 'from')).toEqual({
      value: `${projKey}-${child.seq}`,
      id: childId,
    });
    expect(sideOf(payloadOf(b ?? {}), 'to')).toBeUndefined();
    const a = await act(tx, afterId, 'subtask_add');
    expect(sideOf(payloadOf(a ?? {}), 'to')).toEqual({
      value: `${projKey}-${child.seq}`,
      id: childId,
    });
    expect(sideOf(payloadOf(a ?? {}), 'from')).toBeUndefined();
    expect(await actCount(tx, childId)).toBe(1);
    expect(await actCount(tx, beforeId)).toBe(1);
    expect(await actCount(tx, afterId)).toBe(1);
  });
  // Forced abort: the pool must see none of it.
  expect(await oneRow(db, sql`select id from issue where id = ${childId}`)).toBeNull();
  expect(await actCount(db, childId)).toBe(0);
  expect(await actCount(db, beforeId)).toBe(0);
  expect(await actCount(db, afterId)).toBe(0);
});

it('keeps the existing events when before or after is null, on the tx', async () => {
  // null before: only the child gains a parent; the parent gains the subtask.
  await withTx(async (tx) => {
    const parent = await makeIssueTx(tx);
    const child = await makeIssueTx(tx);
    await recordParentChange(child.id, null, parent.id, fx.actorUser, tx);
    const c = await act(tx, child.id, 'parent');
    const cp = payloadOf(c ?? {});
    expect(sideOf(cp, 'from')).toBeUndefined();
    expect(sideOf(cp, 'to')).toEqual({ value: `${projKey}-${parent.seq}`, id: parent.id });
    const p = await act(tx, parent.id, 'subtask_add');
    expect(sideOf(payloadOf(p ?? {}), 'to')).toEqual({
      value: `${projKey}-${child.seq}`,
      id: child.id,
    });
    expect(await actCount(tx, child.id)).toBe(1);
    expect(await actCount(tx, parent.id)).toBe(1);
  });
  // null after: the child loses its parent; the old parent loses the subtask.
  await withTx(async (tx) => {
    const parent = await makeIssueTx(tx);
    const child = await makeIssueTx(tx);
    await recordParentChange(child.id, parent.id, null, fx.actorUser, tx);
    const c = await act(tx, child.id, 'parent');
    const cp = payloadOf(c ?? {});
    expect(sideOf(cp, 'to')).toBeUndefined();
    expect(sideOf(cp, 'from')).toEqual({ value: `${projKey}-${parent.seq}`, id: parent.id });
    const p = await act(tx, parent.id, 'subtask_remove');
    expect(sideOf(payloadOf(p ?? {}), 'from')).toEqual({
      value: `${projKey}-${child.seq}`,
      id: child.id,
    });
    expect(await actCount(tx, child.id)).toBe(1);
    expect(await actCount(tx, parent.id)).toBe(1);
  });
  expect(
    await count(db, 'issue_activity', sql`issue_id in ${sql.raw(`(${fx.issues.join(',')})`)}`),
  ).toBe(0);
});

it('keeps the default path on the pool: the call commits without an executor', async () => {
  const before = await makeIssueTx(db);
  const after = await makeIssueTx(db);
  const child = await makeIssueTx(db);
  await recordParentChange(child.id, before.id, after.id, fx.actorUser); // no executor: the pool
  const c = await act(db, child.id, 'parent');
  expect(String(c?.actor_name)).toBe(actorName);
  expect(sideOf(payloadOf(c ?? {}), 'from')).toEqual({
    value: `${projKey}-${before.seq}`,
    id: before.id,
  });
  expect(sideOf(payloadOf(c ?? {}), 'to')).toEqual({
    value: `${projKey}-${after.seq}`,
    id: after.id,
  });
  expect((await act(db, before.id, 'subtask_remove'))?.issue_id).toBe(before.id);
  expect((await act(db, after.id, 'subtask_add'))?.issue_id).toBe(after.id);
  // Exact-key cleanup of this committed case.
  await db.execute(
    sql`delete from issue_activity where issue_id in (${child.id}, ${before.id}, ${after.id})`,
  );
  await db.execute(sql`delete from issue where id in (${child.id}, ${before.id}, ${after.id})`);
});

it('propagates an actual insert failure before the awaited return, with the cause chain and no residue', async () => {
  const fn = `ph_fn_${S}`;
  const trg = `ph_trg_${S}`;
  const before = await makeIssueTx(db);
  const after = await makeIssueTx(db);
  const child = await makeIssueTx(db);
  let caught: unknown = null;
  await withTx(async (tx) => {
    // An owned trigger on the same tx blocks the activity insert; the forced abort drops it.
    await tx.execute(
      sql.raw(
        `create function ${fn}() returns trigger as $$ begin ` +
          `raise exception 'MARKER_PH_ACTIVITY_INSERT_BLOCKED'; end; $$ language plpgsql`,
      ),
    );
    await tx.execute(
      sql.raw(
        `create trigger ${trg} before insert on issue_activity for each row execute function ${fn}()`,
      ),
    );
    try {
      await recordParentChange(child.id, before.id, after.id, fx.actorUser, tx);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull(); // the failure propagated before the awaited return
    expect(hasPgError(caught, 'P0001', /MARKER_PH_ACTIVITY_INSERT_BLOCKED/)).toBe(true); // cause chain
  });
  // The tx is aborted after the body; the proof of "nothing advanced" is the pool counts
  // taken after the forced rollback (a SELECT on the aborted tx would itself fail, 25P02).
  expect(await actCount(db, child.id)).toBe(0); // nothing advanced, gone after the abort
  expect(await actCount(db, before.id)).toBe(0);
  expect(await count(db, 'pg_trigger', sql`tgname = ${trg}`)).toBe(0); // owned DDL rolled back
  await db.execute(sql`delete from issue where id in (${child.id}, ${before.id}, ${after.id})`);
});
