import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';

// The feature guard and the cycle reference on a real transaction. assertProjectFeature reads the
// project through getProjectById, and getCycleRef reads a cycle's dates to derive its status, so a
// caller inside a transaction must see the rows it just wrote rather than the pool's older view.
// Every fixture row is written through the executor under test and removed by exact id in a finally.
const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function targetUrl(raw: string | undefined, env: string | undefined): string {
  if (env !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (!raw) throw new Error('DATABASE_URL is required');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!LOOPBACK.has(url.hostname)) throw new Error(`refusing non-loopback host ${url.hostname}`);
  if ((url.port || '5432') !== '5433') throw new Error('refusing a port other than 5433');
  if (/sentinel|trial/i.test(name)) throw new Error('refusing a trial or Sentinel database');
  if (name !== REQUIRED_DB) throw new Error(`refusing ${name}; this suite uses ${REQUIRED_DB}`);
  return raw;
}

// The proof boundary is one process: a worker clone would mean this suite ran under a harness whose
// environment nobody here chose, so it refuses before any dynamic import or client exists.
function targetIsSingleProcess(workerId: string | undefined): void {
  if (workerId) throw new Error('target guard: BUN_TEST_WORKER_ID must be unset (single process)');
}

void targetUrl(process.env.DATABASE_URL, process.env.NODE_ENV);
targetIsSingleProcess(process.env.BUN_TEST_WORKER_ID);

const { db } = await import('@repo/db');
const { assertProjectFeature } = await import('#shared/access');
const { getCycleRef } = await import('../../service');

type Executor = { execute: typeof db.execute };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const made = {
  workspace: [] as number[],
  team: [] as number[],
  project: [] as number[],
  cycle: [] as number[],
};

async function one<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await executor.execute(query)) as unknown as T[];
  return rows[0];
}

// Dates relative to the current day, so "upcoming", "active" and past are stable whenever it runs.
function day(offset: number): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + offset);
  return now.toISOString().slice(0, 10);
}

// A workspace, its team, and one project that stores subtasks on, so a case can turn the section off
// inside its own transaction and prove the guard reads that.
async function fixtures(executor: Executor, tag: string) {
  const suffix = `${tag}-${Date.now()}`;
  const ws = await one<{ id: number }>(
    executor,
    sql`INSERT INTO workspace (name) VALUES (${`ws ${suffix}`}) RETURNING id`,
  );
  made.workspace.push(ws.id);
  const team = await one<{ id: number }>(
    executor,
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws.id}, ${`team ${suffix}`}, ${`fc-${suffix}`}) RETURNING id`,
  );
  made.team.push(team.id);
  const project = await one<{ id: number }>(
    executor,
    sql`INSERT INTO project (team_id, key, name, subtasks_enabled)
        VALUES (${team.id}, ${`F${suffix.slice(-6)}`}, ${`project ${suffix}`}, true) RETURNING id`,
  );
  made.project.push(project.id);
  return {
    workspaceId: ws.id,
    teamId: team.id,
    projectId: project.id,
    projectName: `project ${suffix}`,
  };
}

type Facts = Awaited<ReturnType<typeof fixtures>>;

async function addCycle(
  executor: Executor,
  projectId: number,
  start: number,
  end: number,
  done: boolean,
) {
  const row = await one<{ id: number }>(
    executor,
    sql`INSERT INTO cycle (project_id, name, start_date, end_date, completed_at)
        VALUES (${projectId}, ${`cycle ${start}`}, ${day(start)}, ${day(end)},
                ${done ? sql`now()` : sql`null`}) RETURNING id`,
  );
  made.cycle.push(row.id);
  return row.id;
}

// The guard answers with the existing refusal, so the case reads the same words and status a caller gets.
async function refusalOf(run: () => Promise<void>): Promise<{ status?: number; message?: string }> {
  try {
    await run();
    return {};
  } catch (error) {
    const http = error as { status?: number; message?: string };
    return { status: http.status, message: http.message };
  }
}

// Every delete is attempted even after one fails, the ids are kept until their attempt is made, and
// the failures are asserted empty afterwards: a cleanup that stops halfway would leave owned rows
// behind and report success.
const cleanupErrors: unknown[] = [];

async function attempt(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    cleanupErrors.push(error);
  }
}

// How many of these exact ids still exist, read on the pool so a transaction cannot hide them.
async function residue(ids: {
  workspace: number[];
  team: number[];
  project: number[];
  cycle: number[];
}) {
  const countIn = async (table: string, values: number[]) => {
    if (values.length === 0) return 0;
    const row = await one<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE id = ANY(${sql.raw(`ARRAY[${values.join(',')}]::int[]`)})`,
    );
    return row.n;
  };
  return {
    workspace: await countIn('workspace', ids.workspace),
    team: await countIn('team', ids.team),
    project: await countIn('project', ids.project),
    cycle: await countIn('cycle', ids.cycle),
  };
}

// The ids one case created, so its own residue can be asserted after the cleanup ran.
function idsOf(facts: Facts | null, cycles: number[] = []) {
  return {
    workspace: facts ? [facts.workspaceId] : [],
    team: facts ? [facts.teamId] : [],
    project: facts ? [facts.projectId] : [],
    cycle: cycles,
  };
}

async function cleanUp() {
  const cycles = made.cycle.splice(0);
  const projects = made.project.splice(0);
  const teams = made.team.splice(0);
  const workspaces = made.workspace.splice(0);
  for (const cycleId of cycles) {
    await attempt(() => db.execute(sql`DELETE FROM cycle WHERE id = ${cycleId}`));
  }
  for (const projectId of projects) {
    await attempt(() => db.execute(sql`DELETE FROM cycle WHERE project_id = ${projectId}`));
    await attempt(() => db.execute(sql`DELETE FROM project WHERE id = ${projectId}`));
  }
  for (const teamId of teams) {
    await attempt(() => db.execute(sql`DELETE FROM team WHERE id = ${teamId}`));
  }
  for (const wsId of workspaces) {
    await attempt(() => db.execute(sql`DELETE FROM workspace WHERE id = ${wsId}`));
  }
  expect(cleanupErrors).toEqual([]);
}

describe('the feature guard and the cycle reference on a supplied transaction', () => {
  it('refuses an uncommitted section that was just turned off, and allows one that is on', async () => {
    const rollback = Symbol('rollback');
    let refused: { status?: number; message?: string } = {};
    let allowed = false;
    let poolPassed = false;
    let facts: Facts | null = null;
    try {
      try {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'feature');
          await executor.execute(
            sql`UPDATE project SET subtasks_enabled = false WHERE id = ${facts.projectId}`,
          );
          refused = await refusalOf(() =>
            assertProjectFeature(facts!.projectId, 'subtasks', executor),
          );
          // The same project with the section on passes the same guard on the same transaction.
          await executor.execute(
            sql`UPDATE project SET subtasks_enabled = true WHERE id = ${facts!.projectId}`,
          );
          await assertProjectFeature(facts.projectId, 'subtasks', executor);
          allowed = true;
          // On the pool the project is invisible, and the guard is a no-op for a project it cannot read.
          await assertProjectFeature(facts.projectId, 'subtasks');
          poolPassed = true;
          throw rollback;
        });
        throw new Error('the transaction was not rolled back');
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const f = facts as unknown as Facts;
      expect(allowed).toBe(true);
      expect(poolPassed).toBe(true);
      // The existing refusal, unchanged: 403 and the section's words.
      expect(refused.status).toBe(403);
      expect(refused.message).toBe('Subtasks are turned off for this project');
      expect(
        await one<{ n: number }>(
          db,
          sql`SELECT count(*)::int AS n FROM project WHERE id = ${f.projectId}`,
        ),
      ).toEqual({ n: 0 });
    } finally {
      const ids = idsOf(facts);
      await cleanUp();
      expect(await residue(ids)).toEqual({ workspace: 0, team: 0, project: 0, cycle: 0 });
    }
  }, 60_000);

  it('derives the cycle reference from uncommitted dates, and the pool cannot see the cycle', async () => {
    const rollback = Symbol('rollback');
    let inside: Awaited<ReturnType<typeof getCycleRef>> = null;
    let pool: Awaited<ReturnType<typeof getCycleRef>> = null;
    let facts: Facts | null = null;
    let active = 0;
    let upcoming = 0;
    let completed = 0;
    try {
      try {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'cycle');
          active = await addCycle(executor, facts.projectId, -10, 10, false);
          upcoming = await addCycle(executor, facts.projectId, 5, 15, false);
          completed = await addCycle(executor, facts.projectId, -30, -20, true);
          inside = await getCycleRef(active, executor);
          pool = await getCycleRef(active);
          // The status is still derived from the stored dates, not stored itself.
          const statuses = await Promise.all([
            getCycleRef(active, executor),
            getCycleRef(upcoming, executor),
            getCycleRef(completed, executor),
          ]);
          expect(statuses.map((ref) => ref!.status)).toEqual(['active', 'upcoming', 'completed']);
          throw rollback;
        });
        throw new Error('the transaction was not rolled back');
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const f = facts as unknown as Facts;
      expect(inside!.projectId).toBe(f.projectId);
      expect(inside!.status).toBe('active');
      expect(pool).toBeNull();
      expect(
        await one<{ n: number }>(
          db,
          sql`SELECT count(*)::int AS n FROM cycle WHERE project_id = ${f.projectId}`,
        ),
      ).toEqual({ n: 0 });
    } finally {
      const ids = idsOf(facts, [active, upcoming, completed]);
      await cleanUp();
      expect(await residue(ids)).toEqual({ workspace: 0, team: 0, project: 0, cycle: 0 });
    }
  }, 60_000);

  it('keeps the default pool path and the missing-id controls', async () => {
    let defaultFacts: Facts | null = null;
    let defaultCycle = 0;
    try {
      const f = await fixtures(db, 'default');
      defaultFacts = f;
      // A committed project with the section off is refused on the pool, with the same words.
      await db.execute(sql`UPDATE project SET subtasks_enabled = false WHERE id = ${f.projectId}`);
      const refused = await refusalOf(() => assertProjectFeature(f.projectId, 'subtasks'));
      expect(refused.status).toBe(403);
      expect(refused.message).toBe('Subtasks are turned off for this project');
      // A project that is not there stays a no-op, as before.
      await assertProjectFeature(2_000_000_000, 'subtasks');
      const cycleId = await addCycle(db, f.projectId, -10, 10, false);
      defaultCycle = cycleId;
      const ref = await getCycleRef(cycleId);
      expect(ref).not.toBeNull();
      expect(ref!.projectId).toBe(f.projectId);
      expect(ref!.status).toBe('active');
      expect(await getCycleRef(2_000_000_000)).toBeNull();
    } finally {
      const ids = idsOf(defaultFacts, [defaultCycle]);
      await cleanUp();
      expect(await residue(ids)).toEqual({ workspace: 0, team: 0, project: 0, cycle: 0 });
    }
  }, 60_000);

  it('lets a genuine SELECT failure through instead of swallowing it', async () => {
    let failFacts: Facts | null = null;
    let failCycle = 0;
    let failure: unknown = null;
    try {
      await db.transaction(async (tx) => {
        const executor = tx as unknown as Tx;
        const f = await fixtures(executor, 'fail');
        failFacts = f;
        const cycleId = await addCycle(executor, f.projectId, -10, 10, false);
        failCycle = cycleId;
        // An empty search path makes the reader's own SELECT unresolvable: a real database error,
        // not a timeout and not a fixture mistake, and it rolls back with the transaction.
        await executor.execute(sql`SET LOCAL search_path = pg_catalog`);
        await getCycleRef(cycleId, executor);
      });
    } catch (error) {
      failure = error;
    }
    try {
      // Drizzle wraps the driver error, so the SQLSTATE rides on the cause of the rejection.
      const chain = (error: unknown) => {
        const out: string[] = [];
        type Link = { message?: unknown; code?: unknown; cause?: unknown } | null;
        for (let link = error as Link; link; link = link.cause as Link) {
          out.push(String(link.code ?? '') + String(link.message ?? link));
        }
        return out.join(' | ');
      };
      expect(chain(failure)).toMatch(/42P01|does not exist/);
    } finally {
      const ids = idsOf(failFacts, [failCycle]);
      await cleanUp();
      expect(await residue(ids)).toEqual({ workspace: 0, team: 0, project: 0, cycle: 0 });
    }
  }, 60_000);
});
