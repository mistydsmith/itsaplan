import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';

// The authoritative issue reader on a real transaction. getIssue/getIssues compose a DTO from the
// issue row plus five separate enrichment queries, so a writer that reads back what it just wrote
// needs every one of them on its own transaction. Every fixture row below is written through the
// executor under test and removed by exact id in a finally. No provider, no HTTP, no reset.
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
const { getIssue, getIssues } = await import('../../service');

type Executor = { execute: typeof db.execute };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const made = {
  workspace: [] as number[],
  team: [] as number[],
  project: [] as number[],
  user: [] as string[],
  issue: [] as number[],
};

async function one<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await executor.execute(query)) as unknown as T[];
  return rows[0];
}

// One project with two issues. Every row is written through the executor the case is testing, so a
// supplied transaction holds all of it uncommitted.
async function fixtures(executor: Executor, tag: string) {
  const suffix = `${tag}-${Date.now()}`;
  const ws = await one<{ id: number }>(
    executor,
    sql`INSERT INTO workspace (name) VALUES (${`ws ${suffix}`}) RETURNING id`,
  );
  made.workspace.push(ws.id);
  const team = await one<{ id: number }>(
    executor,
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws.id}, ${`team ${suffix}`}, ${`rd-${suffix}`}) RETURNING id`,
  );
  made.team.push(team.id);
  const project = await one<{ id: number }>(
    executor,
    sql`INSERT INTO project (team_id, key, name) VALUES (${team.id}, ${`R${suffix.slice(-6)}`}, ${`project ${suffix}`}) RETURNING id`,
  );
  made.project.push(project.id);
  const column = await one<{ id: number }>(
    executor,
    sql`INSERT INTO project_column (project_id, name, position) VALUES (${project.id}, 'Todo', 1) RETURNING id`,
  );
  const author = await one<{ id: string }>(
    executor,
    sql`INSERT INTO "user" (id, name, username, email, email_verified)
        VALUES (${`reader-${suffix}`}, 'Reader', ${`reader${suffix.replace(/[^a-z0-9]/gi, '')}`.toLowerCase()}, ${`reader-${suffix}@example.com`}, true) RETURNING id`,
  );
  made.user.push(author.id);
  const initiative = await one<{ id: number }>(
    executor,
    sql`INSERT INTO initiative (project_id, title, status) VALUES (${project.id}, ${`initiative ${suffix}`}, 'active') RETURNING id`,
  );
  const cycle = await one<{ id: number }>(
    executor,
    sql`INSERT INTO cycle (project_id, name, start_date, end_date)
        VALUES (${project.id}, ${`cycle ${suffix}`}, '2026-01-01', '2026-02-01') RETURNING id`,
  );
  const label = await one<{ id: number }>(
    executor,
    sql`INSERT INTO label (project_id, name, color) VALUES (${project.id}, ${`label ${suffix}`}, '#123456') RETURNING id`,
  );
  const ids: number[] = [];
  const issueTitles: string[] = [];
  const enteredAt: string[] = [];
  for (const seq of [1, 2]) {
    const title = `issue ${seq} ${suffix}`;
    issueTitles.push(title);
    enteredAt.push(`2026-03-0${seq}T10:00:00.000Z`);
    const row = await one<{ id: number }>(
      executor,
      sql`INSERT INTO issue (project_id, sequence_number, column_id, title, initiative_id, cycle_id)
          VALUES (${project.id}, ${seq}, ${column.id}, ${title}, ${initiative.id}, ${cycle.id}) RETURNING id`,
    );
    made.issue.push(row.id);
    ids.push(row.id);
    await executor.execute(
      sql`INSERT INTO issue_label (issue_id, label_id) VALUES (${row.id}, ${label.id})`,
    );
    await executor.execute(
      sql`INSERT INTO issue_status (issue_id, column_id, column_name, entered_at)
          VALUES (${row.id}, ${column.id}, 'Todo', ${`2026-03-0${seq}T10:00:00Z`})`,
    );
    await executor.execute(
      sql`INSERT INTO issue_worklog (issue_id, user_id, minutes, spent_on)
          VALUES (${row.id}, ${author.id}, ${seq * 30}, '2026-03-05')`,
    );
  }
  return {
    projectId: project.id,
    issueId: ids[0],
    otherIssueId: ids[1],
    labelId: label.id,
    labelName: `label ${suffix}`,
    initiativeTitle: `initiative ${suffix}`,
    cycleName: `cycle ${suffix}`,
    issueTitles,
    enteredAt,
  };
}

type Facts = Awaited<ReturnType<typeof fixtures>>;

async function rowsFor(executor: Executor, ids: number[]): Promise<number> {
  const row = await one<{ n: number }>(
    executor,
    sql`SELECT count(*)::int AS n FROM issue WHERE id = ANY(${sql.raw(`ARRAY[${ids.join(',')}]::int[]`)})`,
  );
  return row.n;
}

async function cleanUp() {
  for (const issueId of made.issue.splice(0)) {
    await db.execute(sql`DELETE FROM issue_worklog WHERE issue_id = ${issueId}`);
    await db.execute(sql`DELETE FROM issue_status WHERE issue_id = ${issueId}`);
    await db.execute(sql`DELETE FROM issue_label WHERE issue_id = ${issueId}`);
    await db.execute(sql`DELETE FROM issue WHERE id = ${issueId}`);
  }
  for (const projectId of made.project.splice(0)) {
    await db.execute(sql`DELETE FROM cycle WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM initiative WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM label WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM project_column WHERE project_id = ${projectId}`);
    await db.execute(sql`DELETE FROM project WHERE id = ${projectId}`);
  }
  for (const userId of made.user.splice(0))
    await db.execute(sql`DELETE FROM "user" WHERE id = ${userId}`);
  for (const teamId of made.team.splice(0))
    await db.execute(sql`DELETE FROM team WHERE id = ${teamId}`);
  for (const wsId of made.workspace.splice(0))
    await db.execute(sql`DELETE FROM workspace WHERE id = ${wsId}`);
}

describe('the issue reader on a supplied transaction', () => {
  it('composes the whole DTO from uncommitted rows, and the pool cannot see them', async () => {
    const rollback = Symbol('rollback');
    let seen: {
      row: Awaited<ReturnType<typeof getIssue>>;
      pool: Awaited<ReturnType<typeof getIssue>>;
    } | null = null;
    let facts: Facts | null = null;
    try {
      try {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'read');
          seen = {
            row: await getIssue(facts.issueId, executor),
            pool: await getIssue(facts.issueId),
          };
          throw rollback;
        });
        throw new Error('the transaction was not rolled back');
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const f = facts as unknown as Facts;
      const row = seen!.row!;
      expect(row.id).toBe(f.issueId);
      expect(row.title).toBe(f.issueTitles[0]);
      expect(row.labelIds).toEqual([f.labelId]);
      // The state stretch, the groupings and the summed time all came from the same transaction.
      expect(row.statusSince).toBe(f.enteredAt[0]);
      expect(row.initiative).toEqual({
        id: row.initiative!.id,
        title: f.initiativeTitle,
        status: 'active',
      });
      expect(row.cycle!.name).toBe(f.cycleName);
      expect(row.loggedMinutes).toBe(30);
      // The default pool cannot see an uncommitted issue.
      expect(seen!.pool).toBeNull();
      expect(await rowsFor(db, [f.issueId])).toBe(0);
    } finally {
      await cleanUp();
    }
  }, 60_000);

  it('reads several uncommitted issues at once and keeps the empty-list contract', async () => {
    const rollback = Symbol('rollback');
    let inside: Awaited<ReturnType<typeof getIssues>> = [];
    let empty: Awaited<ReturnType<typeof getIssues>> = [];
    let facts: Facts | null = null;
    try {
      try {
        await db.transaction(async (tx) => {
          const executor = tx as unknown as Tx;
          facts = await fixtures(executor, 'many');
          inside = await getIssues([facts.issueId, facts.otherIssueId], executor);
          empty = await getIssues([], executor);
          throw rollback;
        });
        throw new Error('the transaction was not rolled back');
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const f = facts as unknown as Facts;
      expect(inside.map((row) => row.id).sort()).toEqual([f.issueId, f.otherIssueId].sort());
      // Each row carries its own enrichment, not the first row's.
      expect(inside.map((row) => row.loggedMinutes).sort()).toEqual([30, 60]);
      expect(inside.every((row) => row.labelIds.length === 1)).toBe(true);
      const byId = new Map(inside.map((row) => [row.id, row]));
      expect(byId.get(f.issueId)!.title).toBe(f.issueTitles[0]);
      expect(byId.get(f.otherIssueId)!.title).toBe(f.issueTitles[1]);
      expect(byId.get(f.issueId)!.statusSince).toBe(f.enteredAt[0]);
      expect(byId.get(f.otherIssueId)!.statusSince).toBe(f.enteredAt[1]);
      expect(empty).toEqual([]);
      expect(await getIssues([f.issueId, f.otherIssueId])).toEqual([]);
    } finally {
      await cleanUp();
    }
  }, 60_000);

  it('keeps the default pool path and the missing-id contract', async () => {
    try {
      const f = await fixtures(db, 'default');
      const row = await getIssue(f.issueId);
      expect(row).not.toBeNull();
      expect(row!.labelIds).toEqual([f.labelId]);
      expect(row!.initiative!.title).toBe(f.initiativeTitle);
      expect(row!.cycle!.name).toBe(f.cycleName);
      expect(row!.loggedMinutes).toBe(30);
      expect(await getIssue(2_000_000_000)).toBeNull();
    } finally {
      await cleanUp();
    }
  }, 60_000);

  it('lets a genuine SELECT failure through instead of swallowing it', async () => {
    let failure: unknown = null;
    try {
      await db.transaction(async (tx) => {
        const executor = tx as unknown as Tx;
        const f = await fixtures(executor, 'fail');
        // An empty search path makes the reader's own SELECT unresolvable: a real database error,
        // not a timeout and not a fixture mistake, and it rolls back with the transaction.
        await executor.execute(sql`SET LOCAL search_path = pg_catalog`);
        await getIssue(f.issueId, executor);
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
      expect(await rowsFor(db, made.issue.slice())).toBe(0);
    } finally {
      await cleanUp();
    }
  }, 60_000);
});
