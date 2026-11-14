import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';

// The project DTO and the workspace limits readers on a real transaction. getProjectById builds its
// row from project+team and then asks the limits provider what the workspace may use, and that answer
// decides which sections read as off - so both reads have to come from the caller's transaction.
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
const { getProjectById } = await import('../../service');
const { getLimits, getTeamLimits, getRunLimit, setLimitsProvider, NO_LIMITS } =
  await import('#shared/limits');

type Executor = { execute: typeof db.execute };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const made = {
  workspace: [] as number[],
  team: [] as number[],
  project: [] as number[],
};

async function one<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await executor.execute(query)) as unknown as T[];
  return rows[0];
}

// A workspace with a team and one project that stores cycles on. The team's name doubles as this
// case's marker, so a provider can tell from inside its own query whether the caller's transaction is
// visible to it. `maxConcurrentRuns` is the workspace's own ceiling for getRunLimit.
async function fixtures(executor: Executor, tag: string, ownRuns: number) {
  const suffix = `${tag}-${Date.now()}`;
  const markerName = `marker-${suffix}`;
  const ws = await one<{ id: number }>(
    executor,
    sql`INSERT INTO workspace (name, max_concurrent_runs) VALUES (${`ws ${suffix}`}, ${ownRuns}) RETURNING id`,
  );
  made.workspace.push(ws.id);
  const team = await one<{ id: number }>(
    executor,
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws.id}, ${markerName}, ${`pl-${suffix}`}) RETURNING id`,
  );
  made.team.push(team.id);
  const project = await one<{ id: number }>(
    executor,
    sql`INSERT INTO project (team_id, key, name, cycles_enabled)
        VALUES (${team.id}, ${`P${suffix.slice(-6)}`}, ${`project ${suffix}`}, true) RETURNING id`,
  );
  made.project.push(project.id);
  return {
    workspaceId: ws.id,
    teamId: team.id,
    projectId: project.id,
    markerName,
    projectName: `project ${suffix}`,
  };
}

type Facts = Awaited<ReturnType<typeof fixtures>>;

// The provider a hosted build installs: it answers from a query, so it can only see what the executor
// it was handed sees. One argument stays assignable, which the final assertion also checks.
function installQueryingProvider(markerName: string) {
  setLimitsProvider(async (workspaceId: number, executor) => {
    const row = await one<{ n: number }>(
      executor ?? db,
      sql`SELECT count(*)::int AS n FROM team WHERE workspace_id = ${workspaceId} AND name = ${markerName}`,
    );
    if (row.n === 0) return NO_LIMITS;
    return {
      ...NO_LIMITS,
      maxTeams: 4,
      maxConcurrentRuns: 2,
      blockedFeatures: ['cycles'] as const,
    };
  });
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
async function residue(ids: { workspace: number[]; team: number[]; project: number[] }) {
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
  };
}

async function cleanUp() {
  const projects = made.project.splice(0);
  const teams = made.team.splice(0);
  const workspaces = made.workspace.splice(0);
  for (const projectId of projects) {
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

// The ids one case created, so its own residue can be asserted after the cleanup ran.
function idsOf(facts: Facts | null): { workspace: number[]; team: number[]; project: number[] } {
  return facts
    ? { workspace: [facts.workspaceId], team: [facts.teamId], project: [facts.projectId] }
    : { workspace: [], team: [], project: [] };
}

describe('the project DTO and limits readers on a supplied transaction', () => {
  it('masks the DTO from a limits answer read in the same transaction', async () => {
    const rollback = Symbol('rollback');
    let inside: Awaited<ReturnType<typeof getProjectById>> = null;
    let pool: Awaited<ReturnType<typeof getProjectById>> = null;
    let facts: Facts | null = null;
    try {
      try {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'dto', 0);
          installQueryingProvider(facts.markerName);
          inside = await getProjectById(facts.projectId, executor);
          pool = await getProjectById(facts.projectId);
          throw rollback;
        });
        throw new Error('the transaction was not rolled back');
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const f = facts as unknown as Facts;
      expect(inside).not.toBeNull();
      // The project and its team came from the transaction; the pool cannot see either.
      expect(inside!.name).toBe(f.projectName);
      expect(pool).toBeNull();
      // The provider's answer came through the same executor, so the blocked section reads as off
      // even though the project stores it as on, and it leaves availableFeatures.
      expect(inside!.cyclesEnabled).toBe(false);
      expect(inside!.availableFeatures).not.toContain('cycles');
      expect(inside!.availableFeatures).toContain('notes');
      expect(
        await one<{ n: number }>(
          db,
          sql`SELECT count(*)::int AS n FROM project WHERE id = ${f.projectId}`,
        ),
      ).toEqual({ n: 0 });
    } finally {
      setLimitsProvider(async () => NO_LIMITS);
      const ids = idsOf(facts);
      await cleanUp();
      expect(await residue(ids)).toEqual({ workspace: 0, team: 0, project: 0 });
    }
  }, 60_000);

  it('resolves team limits through the transaction for both the workspace lookup and the provider', async () => {
    const rollback = Symbol('rollback');
    let inside: Awaited<ReturnType<typeof getTeamLimits>> | null = null;
    let pool: unknown = null;
    let facts: Facts | null = null;
    try {
      try {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'team', 0);
          installQueryingProvider(facts.markerName);
          inside = await getTeamLimits(facts.teamId, executor);
          // The pool cannot resolve an uncommitted team at all, and teamWorkspaceId throws
          // rather than answering with a default, so the pool reading is a rejection.
          pool = await getTeamLimits(facts.teamId).then(
            (answer) => answer,
            (error: Error) => error,
          );
          throw rollback;
        });
        throw new Error('the transaction was not rolled back');
      } catch (error) {
        if (error !== rollback) throw error;
      }
      expect(inside!.maxTeams).toBe(4);
      expect(inside!.blockedFeatures).toEqual(['cycles']);
      const poolAnswer = pool as unknown as Error;
      expect(poolAnswer).toBeInstanceOf(Error);
      expect(poolAnswer.message).toBe(`Team ${(facts as unknown as Facts).teamId} does not exist`);
    } finally {
      setLimitsProvider(async () => NO_LIMITS);
      const ids = idsOf(facts);
      await cleanUp();
      expect(await residue(ids)).toEqual({ workspace: 0, team: 0, project: 0 });
    }
  }, 60_000);

  it('reads the workspace ceiling for getRunLimit on the transaction and takes the tighter bound', async () => {
    const rollback = Symbol('rollback');
    const seen = { tighter: 0, own: 0, pool: 0, unlimited: 0 };
    let unchanged = false;
    let runFacts: Facts | null = null;
    try {
      try {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          const f = await fixtures(executor, 'runs', 5);
          runFacts = f;
          unchanged =
            (
              await one<{ own: number }>(
                executor,
                sql`SELECT max_concurrent_runs AS own FROM workspace WHERE id = ${f.workspaceId}`,
              )
            ).own === 5;
          // own 5 with the provider's 2: the tighter one wins.
          seen.tighter = await getRunLimit(
            f.workspaceId,
            { ...NO_LIMITS, maxConcurrentRuns: 2 },
            executor,
          );
          // own 5 with no provider ceiling: the workspace's own number stands, and reading left it alone.
          seen.own = await getRunLimit(f.workspaceId, NO_LIMITS, executor);
          // On the pool the uncommitted row is invisible, so it reads the unlimited ceiling.
          seen.pool = await getRunLimit(f.workspaceId, NO_LIMITS);
          // After the row is set to 0 the same call reports 0, which reads as unlimited.
          await executor.execute(
            sql`UPDATE workspace SET max_concurrent_runs = 0 WHERE id = ${f.workspaceId}`,
          );
          seen.unlimited = await getRunLimit(f.workspaceId, NO_LIMITS, executor);
          throw rollback;
        });
        throw new Error('the transaction was not rolled back');
      } catch (error) {
        if (error !== rollback) throw error;
      }
      expect(seen.tighter).toBe(2);
      expect(seen.own).toBe(5);
      expect(seen.unlimited).toBe(0);
      expect(unchanged).toBe(true);
    } finally {
      setLimitsProvider(async () => NO_LIMITS);
      const ids = idsOf(runFacts);
      await cleanUp();
      expect(await residue(ids)).toEqual({ workspace: 0, team: 0, project: 0 });
    }
  }, 60_000);

  it('keeps the default pool path, the missing-id contract and the default provider', async () => {
    let defaultFacts: Facts | null = null;
    try {
      const f = await fixtures(db, 'default', 0);
      defaultFacts = f;
      installQueryingProvider(f.markerName);
      const row = await getProjectById(f.projectId);
      expect(row!.name).toBe(f.projectName);
      // On the pool the provider sees the committed team, so the same masking applies.
      expect(row!.cyclesEnabled).toBe(false);
      expect(await getProjectById(2_000_000_000)).toBeNull();
      // One-argument providers stay assignable, and the default answer is restored here.
      setLimitsProvider(async () => NO_LIMITS);
      expect(await getLimits(f.workspaceId)).toEqual(NO_LIMITS);
      expect(await getLimits(f.workspaceId, db)).toEqual(NO_LIMITS);
    } finally {
      setLimitsProvider(async () => NO_LIMITS);
      const ids = idsOf(defaultFacts);
      await cleanUp();
      expect(await residue(ids)).toEqual({ workspace: 0, team: 0, project: 0 });
    }
  }, 60_000);

  it('lets a genuine SELECT failure through instead of swallowing it', async () => {
    let failure: unknown = null;
    let failFacts: Facts | null = null;
    try {
      await db.transaction(async (tx) => {
        const executor = tx as unknown as Tx;
        const f = await fixtures(executor, 'fail', 0);
        failFacts = f;
        // An empty search path makes the reader's own SELECT unresolvable: a real database error,
        // not a timeout and not a fixture mistake, and it rolls back with the transaction.
        await executor.execute(sql`SET LOCAL search_path = pg_catalog`);
        await getProjectById(f.projectId, executor);
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
      setLimitsProvider(async () => NO_LIMITS);
      const ids = idsOf(failFacts);
      await cleanUp();
      expect(await residue(ids)).toEqual({ workspace: 0, team: 0, project: 0 });
    }
  }, 60_000);
});
