import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
// The ordinary comment edit racing a move of its issue into a gated project, on real rows, the public
// writer and the pinned R5 owner, no mock. WHY this file exists: the ordinary path judges the edit on
// the project its pool read saw; only the issue FOR SHARE fence and its project recheck stop a move
// committed under it from landing an ungated body, history row and effects in a gated project.
// DATABASE HELD: without Root's grant this file refuses before any client exists; it never resets,
// migrates, or deletes a rig or ledger row. FIXTURE DDL: the landed 0183 SQL, applied only after
// proving none of its objects exist, and exactly those objects dropped afterAll.
import { sql } from 'drizzle-orm';

const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const GRANT = 'ITSAPLAN_8364_E3_MOVE_RACE';
const OWNER_CONFIG =
  '/Users/misty/Output/reports/itsaplan_cutover_20261114_ROOT_R1/8364_owner_composition/CONFIG.json';
const MIGRATION = new URL(
  '../../../../../../../packages/db/drizzle/0183_comment_version.sql',
  import.meta.url,
);
const MARK = 'zz_ct_e3mv';

function grantAndTarget(): void {
  if (process.env[GRANT] !== 'granted')
    throw new Error(`DB held: this suite runs only when ${GRANT}=granted is set by Root's DB GO`);
  if (process.env.NODE_ENV !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (process.env.BUN_TEST_WORKER_ID) throw new Error('these tests run serial, with no worker id');
  const url = new URL(process.env.DATABASE_URL ?? '');
  const name = url.pathname.replace(/^\//, '');
  if (!LOOPBACK.has(url.hostname)) throw new Error(`refusing non-loopback host ${url.hostname}`);
  if ((url.port || '5432') !== '5433') throw new Error('refusing a port other than 5433');
  if (name !== REQUIRED_DB) throw new Error(`refusing ${name}; this suite uses ${REQUIRED_DB}`);
}
grantAndTarget();
const { db } = await import('@repo/db');
const { TRACKER_GATE_ENV } = await import('@repo/db/tracker-gate');
const { updateComment } = await import('../../activity');

type Query = ReturnType<typeof sql>;
const rows = async <T>(query: Query) => (await db.execute(query)) as unknown as T[];
const one = async <T>(query: Query) => (await rows<T>(query))[0];
const n = async (query: Query) => (await one<{ n: number }>(query)).n;

// Every object 0183 creates, counted by name. WHY before any DDL: if one already exists, the
// final drop could remove something this run does not own, so the suite refuses instead.
const OBJECTS_0183 = sql`SELECT
  (to_regclass('public.comment_version') IS NOT NULL)::int
  + (to_regclass('public.comment_version_id_seq') IS NOT NULL)::int
  + (to_regclass('public.comment_version_lookup_idx') IS NOT NULL)::int
  + (SELECT count(*)::int FROM pg_proc WHERE proname = 'comment_version_immutable')
  + (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'comment_version_no_update')
  + (SELECT count(*)::int FROM pg_constraint WHERE starts_with(conname, 'comment_version_')) AS n`;
// Exact ids for = ANY(...): scalar bound parameters in a typed array, never a JS array bind (Drizzle
// renders that as a parenthesized record). An empty list gives an empty typed array.
const textIds = (ids: (number | string)[]) =>
  sql`ARRAY[${sql.join(
    ids.map((id) => sql`${String(id)}`),
    sql`, `,
  )}]::text[]`;
const intIds = (ids: number[]) =>
  sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}::int`),
    sql`, `,
  )}]::int[]`;

const OWNER = JSON.parse(readFileSync(OWNER_CONFIG, 'utf8')) as { python: string; owner: string };
const GATE = {
  [TRACKER_GATE_ENV.python]: OWNER.python,
  [TRACKER_GATE_ENV.owner]: OWNER.owner,
  [TRACKER_GATE_ENV.manifest]: OWNER_CONFIG,
};
async function withOwner<T>(run: () => Promise<T>): Promise<T> {
  const prior = Object.keys(GATE).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, GATE);
  try {
    return await run();
  } finally {
    for (const [name, value] of prior)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

// What this run created, by exact id, in delete order; `ever` survives cleanup for the residue case.
const ALL = ['issue', 'webhook', 'project_column', 'project', 'team', 'workspace', '"user"'];
const made: Record<string, (number | string)[]> = Object.fromEntries(ALL.map((t) => [t, []]));
const ever: Record<string, (number | string)[]> = Object.fromEntries(ALL.map((t) => [t, []]));
const cleanupErrors: string[] = [];
async function makeRow<T extends number | string = number>(table: string, insert: Query) {
  const id = (await one<{ id: T }>(insert)).id;
  made[table].push(id);
  ever[table].push(id);
  return id;
}

// A synthetic rig this run creates and, like every rig, never deletes: it holds no identity.
const RIG_PREFIX = `cte3mv${randomUUID().replace(/-/g, '')}`;
const PLAIN_BODY = 'the author kept an earlier note here';

// One team holding an ordinary source project and a gated destination, each with a column and a
// comment.updated webhook; the author and member2 belong to both, so a leaked mention would show.
async function fixture() {
  const ws = await makeRow(
    'workspace',
    sql`INSERT INTO workspace (name) VALUES (${MARK}) RETURNING id`,
  );
  const team = await makeRow(
    'team',
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws}, ${MARK}, ${`${MARK}-${ws}`}) RETURNING id`,
  );
  const rigId = await n(sql`INSERT INTO rig (prefix) VALUES (${RIG_PREFIX}) RETURNING id AS n`);
  const users: Record<'author' | 'member2', string> = { author: '', member2: '' };
  // The stored usernames, so the test mentions exactly the handle the fixture wrote.
  const handles: Record<'author' | 'member2', string> = { author: '', member2: '' };
  for (const name of ['author', 'member2'] as const) {
    handles[name] = `${name}mv${ws}`;
    users[name] = await makeRow<string>(
      '"user"',
      sql`INSERT INTO "user" (id, name, username, email, email_verified)
          VALUES (${`${MARK}-${name}-${ws}`}, ${name}, ${handles[name]}, ${`${name}-mv${ws}@example.com`}, true) RETURNING id`,
    );
  }
  const place = async (key: string, rig: number | null) => {
    const projectId = await makeRow(
      'project',
      sql`INSERT INTO project (team_id, key, name, rig_id) VALUES (${team}, ${`${key}${ws}`}, ${MARK}, ${rig}) RETURNING id`,
    );
    const columnId = await makeRow(
      'project_column',
      sql`INSERT INTO project_column (project_id, name, position) VALUES (${projectId}, 'Todo', 1) RETURNING id`,
    );
    for (const userId of Object.values(users))
      await db.execute(sql`INSERT INTO project_member (project_id, user_id, role)
          VALUES (${projectId}, ${userId}, 'member')`);
    await makeRow(
      'webhook',
      sql`INSERT INTO webhook (project_id, url, secret, events)
          VALUES (${projectId}, 'https://example.invalid/hook', 'dummy', '["comment.updated"]'::jsonb) RETURNING id`,
    );
    return { projectId, columnId };
  };
  const source = await place('CMS', null);
  const target = await place('CMT', rigId);
  const issueId = await makeRow(
    'issue',
    sql`INSERT INTO issue (project_id, sequence_number, column_id, title, description)
        VALUES (${source.projectId}, 1, ${source.columnId}, 'Move race', 'Plain card prose.') RETURNING id`,
  );
  const commentId = await n(sql`INSERT INTO issue_activity (issue_id, kind, actor_user_id, body)
      VALUES (${issueId}, 'comment', ${users.author}, ${PLAIN_BODY}) RETURNING id AS n`);
  return { ...users, handles, rigId, source, target, issueId, commentId };
}

// Everything the edit could have moved, keyed on the issue and both projects' webhooks, in one read.
async function edited(issueId: number, projectIds: number[]) {
  return one<Record<string, unknown>>(sql`
    SELECT (SELECT project_id FROM issue WHERE id = ${issueId}) AS "projectId",
      (SELECT count(*)::int FROM issue_activity WHERE issue_id = ${issueId}) AS activity,
      (SELECT string_agg(body, '|' ORDER BY id) FROM issue_activity WHERE issue_id = ${issueId} AND kind = 'comment') AS bodies,
      (SELECT count(*)::int FROM comment_version WHERE issue_id = ${issueId}) AS versions,
      (SELECT count(*)::int FROM issue_watcher WHERE issue_id = ${issueId}) AS watchers,
      (SELECT count(*)::int FROM notification WHERE issue_id = ${issueId}) AS notifications,
      (SELECT count(*)::int FROM agent_run WHERE issue_id = ${issueId}) AS runs,
      (SELECT count(*)::int FROM webhook_delivery WHERE webhook_id IN
        (SELECT id FROM webhook WHERE project_id = ANY(${intIds(projectIds)}))) AS deliveries`);
}

async function cleanUp(): Promise<void> {
  for (const table of ALL)
    for (const id of made[table].splice(0))
      await db
        .execute(sql`DELETE FROM ${sql.raw(table)} WHERE id = ${id}`)
        .catch((e: Error) => cleanupErrors.push(`${table} ${id}: ${e.message}`));
}

describe('the ordinary comment edit against a concurrent move into a gated project', () => {
  // Registered before any hook runs. It drops only what this run's own committed DDL created: a
  // refused or failed setup leaves `owned` false, and foreign objects are never touched.
  let owned = false;
  afterAll(async () => {
    if (!owned) return;
    const errors: string[] = [];
    for (const drop of [
      'DROP TRIGGER comment_version_no_update ON comment_version',
      'DROP TABLE comment_version',
      'DROP FUNCTION comment_version_immutable()',
    ])
      await db.execute(sql.raw(drop)).catch((e: Error) => errors.push(`${drop}: ${e.message}`));
    const left = await n(OBJECTS_0183);
    if (errors.length > 0 || left !== 0)
      throw new Error(`fixture DDL not fully dropped (${left} left): ${errors.join('; ')}`);
  });
  // The landed migration text, statement by statement, on one transaction: all of it or none.
  beforeAll(async () => {
    if ((await n(OBJECTS_0183)) !== 0)
      throw new Error('refusing: a comment_version object already exists; this run owns none');
    await db.transaction(async (tx) => {
      for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint'))
        if (statement.trim()) await tx.execute(sql.raw(statement));
    });
    owned = true;
  });
  afterEach(cleanUp);

  it('waits on the issue fence behind the uncommitted move, then refuses 409 and moves nothing', async () => {
    const f = await fixture();
    const projects = [f.source.projectId, f.target.projectId];
    const before = await edited(f.issueId, projects);
    expect(before.projectId).toBe(f.source.projectId);
    let release!: () => void;
    let startHolding!: (pid: number) => void;
    const gate = new Promise<void>((r) => (release = r));
    const holding = new Promise<number>((resolve) => (startHolding = resolve));
    // The holder moves the issue into the gated project and keeps that transaction open; the edit's
    // pool read still sees the source project, so it takes the ordinary branch.
    const held = db.transaction(async (tx) => {
      const pid = (
        (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as { pid: number }[]
      )[0].pid;
      await tx.execute(sql`UPDATE issue SET project_id = ${f.target.projectId},
          column_id = ${f.target.columnId} WHERE id = ${f.issueId}`);
      startHolding(pid);
      await gate;
    });
    let holderError: unknown = null;
    const settled = held.catch((error) => (holderError = error));
    let attempt: Promise<unknown> | null = null;
    // Whatever fails still releases the holder and settles both sides: a mutant that lets the edit
    // through must fail this case, not hang the process or leave an unhandled rejection.
    try {
      const holderPid = await Promise.race([holding, settled.then(() => -1)]);
      if (holderError !== null || holderPid === -1)
        throw new Error(`holder failed: ${String(holderError)}`);
      const body = `moved edit ${randomUUID()} @${f.handles.member2}`;
      attempt = withOwner(() =>
        updateComment(f.commentId, body, f.author, f.source.projectId),
      ).then(
        () => 'allowed',
        (error: unknown) => error,
      );
      // Actual blocking, not a sleep: a backend of this database waits on a lock the holder owns,
      // and the statement it waits in is the issue row FOR SHARE, the fence under test.
      let waiter: { pid: number; query: string } | undefined;
      for (let i = 0; i < 200 && !waiter; i += 1) {
        waiter = await one<{ pid: number; query: string }>(sql`
          SELECT pid, query FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND ${holderPid} = ANY(pg_blocking_pids(pid))`);
        if (!waiter) await new Promise((r) => setTimeout(r, 250));
      }
      expect(waiter).toBeDefined();
      expect(waiter?.query).toMatch(/FROM\s+issue\s+WHERE\s+id\s*=.*FOR SHARE/s);
      expect(await edited(f.issueId, projects)).toEqual(before);
      release();
      await settled;
      expect(holderError).toBeNull();
      const error = await attempt;
      expect(error).toMatchObject({
        status: 409,
        message: 'This issue moved projects while it was being updated; try again',
      });
      // The move committed; the edit left no body, history row, activity entry, watcher,
      // notification, run or webhook delivery in either project.
      expect(await edited(f.issueId, projects)).toEqual({
        ...before,
        projectId: f.target.projectId,
      });
    } finally {
      release();
      if (attempt !== null) await attempt;
      await settled;
    }
  }, 120_000);

  it('leaves nothing behind but the synthetic rig, which holds no identity', async () => {
    expect(cleanupErrors).toEqual([]);
    const left: Record<string, number> = {};
    for (const table of ALL)
      left[table] = await n(
        sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE id::text = ANY(${textIds(ever[table])})`,
      );
    expect(left).toEqual(Object.fromEntries(ALL.map((t) => [t, 0])));
    expect(await n(sql`SELECT count(*)::int AS n FROM comment_version`)).toBe(0);
    const ledger = await n(sql`SELECT count(*)::int AS n FROM bead_identity b
        JOIN rig r ON r.id = b.rig_id WHERE r.prefix = ${RIG_PREFIX}`);
    expect(ledger).toBe(0);
  }, 120_000);
});
