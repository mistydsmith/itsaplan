import { afterAll, beforeAll, expect, it } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '@repo/db';
import { HttpError } from '#shared/lib';

// Real-TX integration test for the column readers (8364 D2): columnAutoAssignee /
// wipLimitBreach / assertWipLimit take a trailing executor, so the column metadata and
// live-issue counts of one read stay in the caller's transaction. Self-contained fixtures
// (no reset / migration / provider, no rig/ledger rows). The exact-target / NODE_ENV /
// no-worker guard runs BEFORE any DB import; the db handle and code under test import after.

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
let columnAutoAssignee: typeof import('../../service').columnAutoAssignee;
let wipLimitBreach: typeof import('../../service').wipLimitBreach;
let assertWipLimit: typeof import('../../service').assertWipLimit;
let WIP_LIMIT_EXCEEDED = '';

// Ids this run actually wrote; a field is set only after its insert returned.
const fx = {
  ws: 0,
  team: 0,
  proj: 0,
  col: 0,
  user: `CrU-${S}`,
  issues: [] as number[],
};
const wsName = `CrWS ${S}`;
const teamName = `CrTeam ${S}`;
const projName = `CrProj ${S}`;
const projKey = `CrK${S}`;
const colName = `CrCol ${S}`;
const userName = `CrActor ${S}`;
// Deterministic monotonic per-run sequences: issues of one project never collide.
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
// A non-archived issue on the column with a deterministic sequence.
async function makeIssueTx(tx: Ex): Promise<number> {
  const seq = ++seqCounter;
  const id = await insertId(
    tx,
    sql`insert into issue (project_id, sequence_number, column_id, title)
        values (${fx.proj}, ${seq}, ${fx.col}, ${`CrTx ${S}`}) returning id`,
  );
  fx.issues.push(id);
  return id;
}
async function columnState(
  ex: Ex,
): Promise<{ limit: number | null; mode: string; user: string | null }> {
  const r = await oneRow(
    ex,
    sql`select wip_limit, wip_mode, auto_assign_user_id from project_column where id = ${fx.col}`,
  );
  return {
    limit: r == null ? null : r.wip_limit == null ? null : Number(r.wip_limit),
    mode: String(r?.wip_mode ?? ''),
    user: r?.auto_assign_user_id == null ? null : String(r.auto_assign_user_id),
  };
}
async function issueCount(ex: Ex): Promise<number> {
  return count(ex, 'issue', sql`column_id = ${fx.col} and archived_at is null`);
}

// Run the body on a fresh transaction and force it to roll back; body failures propagate after.
async function withTx(body: (tx: Ex) => Promise<void>): Promise<void> {
  let failure: unknown = null;
  try {
    await db.transaction(async (tx) => {
      await body(tx as Ex);
      throw new Error('cr-abort'); // force the rollback once the body has asserted
    });
  } catch (e) {
    if ((e as Error).message === 'cr-abort') return;
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
  const svc = await import('../../service');
  ({ columnAutoAssignee, wipLimitBreach, assertWipLimit } = svc);
  WIP_LIMIT_EXCEEDED = svc.WIP_LIMIT_EXCEEDED;
  fx.ws = await insertId(db, sql`insert into workspace (name) values (${wsName}) returning id`);
  fx.team = await insertId(
    db,
    sql`insert into team (workspace_id, name) values (${fx.ws}, ${teamName}) returning id`,
  );
  fx.proj = await insertId(
    db,
    sql`insert into project (team_id, "key", name) values (${fx.team}, ${projKey}, ${projName}) returning id`,
  );
  // The owned column starts with no limit and the default soft mode.
  fx.col = await insertId(
    db,
    sql`insert into project_column (project_id, name, position) values (${fx.proj}, ${colName}, 1) returning id`,
  );
  await db.execute(
    sql`insert into "user" (id, name, email, email_verified, username)
        values (${fx.user}, ${userName}, ${`${fx.user}@scratch.test`}, true, ${fx.user})`,
  );
});

afterAll(async () => {
  // Clean up, collecting errors; the asserts run after cleanup so a failure never skips it.
  const cleanupErrors: unknown[] = [];
  const inList = sql.raw(fx.issues.length ? `(${fx.issues.join(',')})` : '(0)');
  for (const q of [
    sql`delete from issue where id in ${inList}`,
    sql`delete from project_column where id = ${fx.col}`,
    sql`delete from project where id = ${fx.proj}`,
    sql`delete from team where id = ${fx.team}`,
    sql`delete from workspace where id = ${fx.ws}`,
    sql`delete from "user" where id = ${fx.user}`,
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
  expect(await count(db, 'issue', sql`id in ${inList}`)).toBe(0);
  expect(await count(db, '"user"', sql`id = ${fx.user}`)).toBe(0);
});

it('reads the uncommitted auto-assignee on the tx while the pool still sees the old value', async () => {
  expect(await columnAutoAssignee(fx.col)).toBeNull(); // committed: unset
  let txUser: string | null = null;
  await withTx(async (tx) => {
    await tx.execute(
      sql`update project_column set auto_assign_user_id = ${fx.user} where id = ${fx.col}`,
    );
    txUser = await columnAutoAssignee(fx.col, tx); // uncommitted value, on the caller tx
    expect(txUser).toBe(fx.user);
    expect(await columnAutoAssignee(fx.col)).toBeNull(); // the pool cannot see it yet
    expect(await columnAutoAssignee(999999, tx)).toBeNull(); // missing column stays null
  });
  const after = await columnState(db);
  expect(after.user).toBeNull(); // forced abort restored the committed value
  expect(await wipLimitBreach(fx.col)).toBeNull(); // default pool call still behaves as before
});

it('sees uncommitted column metadata and live issues on the tx: boundary, hard, soft, null, archived', async () => {
  await withTx(async (tx) => {
    // Uncommitted metadata: the limit and hard mode exist only inside this tx.
    await tx.execute(
      sql`update project_column set wip_limit = 2, wip_mode = 'hard' where id = ${fx.col}`,
    );
    const i1 = await makeIssueTx(tx);
    expect(await wipLimitBreach(fx.col, 1, tx)).toBeNull(); // 1 + 1 == 2: the boundary fits
    await makeIssueTx(tx);
    const breach = await wipLimitBreach(fx.col, 1, tx); // 2 + 1 > 2: hard refusal
    expect(breach).toBeInstanceOf(HttpError);
    expect(breach?.status).toBe(409);
    expect(breach?.code).toBe(WIP_LIMIT_EXCEEDED);
    expect(breach?.message).toBe(`Column "${colName}" is at its WIP limit of 2`);
    // Archived issues are off the board and do not occupy the column.
    await tx.execute(sql`update issue set archived_at = now() where id = ${i1}`);
    expect(await wipLimitBreach(fx.col, 1, tx)).toBeNull(); // only one live issue now
    // Soft mode and a NULL limit never refuse, even far over.
    await tx.execute(sql`update project_column set wip_mode = 'soft' where id = ${fx.col}`);
    expect(await wipLimitBreach(fx.col, 5, tx)).toBeNull();
    await tx.execute(sql`update project_column set wip_limit = null where id = ${fx.col}`);
    expect(await wipLimitBreach(fx.col, 5, tx)).toBeNull();
    expect(await wipLimitBreach(999999, 1, tx)).toBeNull(); // missing column: no breach
  });
  // Forced abort: the pool still sees the committed column (no limit) and no issues.
  const after = await columnState(db);
  expect(after.limit).toBeNull();
  expect(after.mode).toBe('soft');
  expect(await issueCount(db)).toBe(0);
  expect(await wipLimitBreach(fx.col)).toBeNull(); // default pool path unchanged
});

it('assertWipLimit rejects the awaited call with the exact existing HttpError', async () => {
  let caught: unknown = null;
  await withTx(async (tx) => {
    await tx.execute(
      sql`update project_column set wip_limit = 1, wip_mode = 'hard' where id = ${fx.col}`,
    );
    await makeIssueTx(tx);
    try {
      await assertWipLimit(fx.col, 1, tx); // 1 + 1 > 1: must reject
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError); // the failure propagated before the awaited return
    expect((caught as HttpError).status).toBe(409);
    expect((caught as HttpError).code).toBe(WIP_LIMIT_EXCEEDED);
    expect((caught as HttpError).message).toBe(`Column "${colName}" is at its WIP limit of 1`);
    // The allowed boundary resolves on the same tx: 1 + 1 == 2.
    await tx.execute(sql`update project_column set wip_limit = 2 where id = ${fx.col}`);
    await assertWipLimit(fx.col, 1, tx); // 1 + 1 == 2: fits
  });
  expect(caught).toBeInstanceOf(HttpError);
  expect(await issueCount(db)).toBe(0); // forced abort left no issues behind
  // The default incoming=1 on the default pool, with committed own fixtures.
  await db.execute(
    sql`update project_column set wip_limit = 1, wip_mode = 'hard' where id = ${fx.col}`,
  );
  await makeIssueTx(db); // committed; afterAll deletes it by tracked id
  let poolCaught: unknown = null;
  try {
    await assertWipLimit(fx.col); // default incoming 1: 1 + 1 > 1
  } catch (e) {
    poolCaught = e;
  }
  expect(poolCaught).toBeInstanceOf(HttpError);
  expect((poolCaught as HttpError).status).toBe(409);
  expect((poolCaught as HttpError).code).toBe(WIP_LIMIT_EXCEEDED);
  // Restore the owned column to its committed no-limit state (exact own cleanup).
  await db.execute(
    sql`update project_column set wip_limit = null, wip_mode = 'soft' where id = ${fx.col}`,
  );
});

it('propagates an actual SELECT failure before the awaited return, with the cause chain and no residue', async () => {
  // Case 3's committed own issue may still sit in the column until afterAll; the rollback
  // proof is that the owned count is unchanged by the failed tx, not that it is zero.
  const before = await issueCount(db);
  let caught: unknown = null;
  await withTx(async (tx) => {
    // Hide the public schema from this tx only (SET LOCAL rolls back with it), the way
    // the A4 tests do: the reader's own unqualified SELECT then fails with a real
    // undefined relation on the caller's connection.
    await tx.execute(sql.raw(`set local search_path = pg_catalog`));
    try {
      await wipLimitBreach(fx.col, 1, tx); // its column metadata SELECT must fail
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull(); // the failure propagated before the awaited return
    expect(hasPgError(caught, '42P01', /project_column/)).toBe(true); // cause chain
  });
  expect(await issueCount(db)).toBe(before); // forced abort left the owned count unchanged
  expect(await wipLimitBreach(fx.col)).toBeNull(); // the pool default path works normally again
});
