import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
// The gated update: what the shared @repo/db gate refuses on a rig-gated project, and what it
// leaves untouched — the same reviewed Python owner the create suites use, no mock, no stub.
// DATABASE HELD: without the grant flag this file refuses before any client exists; it never
// resets a schema, creates a database, runs a migration or sender, disables a trigger, or
// deletes a rig or a ledger row. RETAINED FIXTURES: updateIssue owns its own transaction, so
// this proof cannot roll back; this run KEEPS one named rig (RIG_PREFIX) plus its tombstones,
// removes everything else by exact id, and the last case states the residue.
const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const GRANT = 'ITSAPLAN_8364_D3_UPDATE_PROOF';
const OWNER_CONFIG = '/Users/misty/Output/reports/8364_root_policy_owner_R3/CONFIG.json';
const MARK = 'zz_qwen3_d3uw';
const RIG_PREFIX = `q3uw${randomUUID().replace(/-/g, '')}`;
type Fixture = {
  id: number;
  columnId: number;
  secondColumnId: number;
  rigId: number | null;
  labelIds: number[];
};
type LedgerRow = { local_token: string; origin: string; issue_id: number | null };
function grantAndTarget(): string {
  if (process.env[GRANT] !== 'granted')
    throw new Error(`DB held: set ${GRANT}=granted via Root's serial DB GO`);
  if (process.env.NODE_ENV !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (process.env.BUN_TEST_WORKER_ID) throw new Error('these tests run serial, with no worker id');
  const url = new URL(process.env.DATABASE_URL ?? '');
  const name = url.pathname.replace(/^\//, '');
  if (!LOOPBACK.has(url.hostname)) throw new Error(`refusing non-loopback host ${url.hostname}`);
  if (url.port !== '5433') throw new Error('refusing a port other than 5433');
  if (name !== REQUIRED_DB) throw new Error(`refusing ${name}; this suite uses ${REQUIRED_DB}`);
  return url.toString();
}
void grantAndTarget();
const { db } = await import('@repo/db');
const { createIssue, updateIssue } = await import('../../service');
const { getProjectById } = await import('../../../projects/service');
const { TRACKER_GATE_ENV } = await import('@repo/db/tracker-gate');
const { sql } = await import('drizzle-orm');
const OWNER = JSON.parse(readFileSync(OWNER_CONFIG, 'utf8')) as Record<string, string>;
async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(query)) as unknown as T[])[0];
}
async function withGateEnv<T>(env: [string, string, string], run: () => Promise<T>) {
  const names = [TRACKER_GATE_ENV.python, TRACKER_GATE_ENV.owner, TRACKER_GATE_ENV.manifest];
  const prior = names.map((name) => process.env[name]);
  names.forEach((name, i) => (process.env[name] = env[i]));
  try {
    return await run();
  } finally {
    names.forEach((name, i) => {
      if (prior[i] === undefined) delete process.env[name];
      else process.env[name] = prior[i];
    });
  }
}
const withOwner = <T>(run: () => Promise<T>) =>
  withGateEnv([OWNER.python, OWNER.owner, OWNER_CONFIG], run);
const withNoConfig = <T>(run: () => Promise<T>) => withGateEnv(['', '', ''], run);
const BUCKETS = ['issue', 'label', 'column', 'project', 'team', 'workspace', 'rig'] as const;
type Bucket = (typeof BUCKETS)[number];
const made = Object.fromEntries(BUCKETS.map((b) => [b, []])) as unknown as Record<Bucket, number[]>;
const CLEANUP: [Bucket, string][] = [
  ['issue', 'issue'],
  ['label', 'label'],
  ['column', 'project_column'],
  ['project', 'project'],
  ['team', 'team'],
  ['workspace', 'workspace'],
];
const minted: string[] = [];
const madeUsers: string[] = [];
const cleanupErrors: string[] = [];
const base = await one<{ identities: number; rigs: number }>(
  sql`SELECT (SELECT count(*) FROM bead_identity)::int AS identities, (SELECT count(*) FROM rig)::int AS rigs`,
);
async function makeRow(bucket: Bucket, insert: ReturnType<typeof sql>): Promise<number> {
  const id = (await one<{ id: number }>(insert)).id;
  made[bucket].push(id);
  return id;
}
let rigId: number | null = null;
async function sharedRig(): Promise<number> {
  if (rigId === null)
    rigId = await makeRow('rig', sql`INSERT INTO rig (prefix) VALUES (${RIG_PREFIX}) RETURNING id`);
  return rigId;
}
async function cleanUp(): Promise<void> {
  for (const [bucket, table] of CLEANUP) {
    for (const id of made[bucket].splice(0)) {
      try {
        await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE id = ${id}`);
      } catch (error) {
        cleanupErrors.push(`${table} ${id}: ${(error as Error).message}`);
      }
    }
  }
  for (const id of madeUsers.splice(0)) {
    try {
      await db.execute(sql`DELETE FROM "user" WHERE id = ${id}`);
    } catch (error) {
      cleanupErrors.push(`user ${id}: ${(error as Error).message}`);
    }
  }
}
async function board(projectId: number) {
  return one<Record<string, number>>(
    sql`SELECT (SELECT next_sequence FROM project WHERE id = ${projectId}) AS seq, (SELECT count(*)::int FROM issue WHERE project_id = ${projectId}) AS issues, (SELECT count(*)::int FROM issue_label WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS labels, (SELECT count(*)::int FROM issue_activity WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS activity, (SELECT count(*)::int FROM notification WHERE project_id = ${projectId}) AS notifications, (SELECT count(*)::int FROM agent_run WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS runs, (SELECT count(*)::int FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE project_id = ${projectId})) AS webhooks`,
  );
}

async function fixture(gated: boolean, second: { stateType: string; autoAssign?: string }) {
  const ws = await makeRow(
    'workspace',
    sql`INSERT INTO workspace (name) VALUES (${`${MARK} ws`}) RETURNING id`,
  );
  const team = await makeRow(
    'team',
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws}, ${`${MARK} team`}, ${`${MARK}-${ws}`}) RETURNING id`,
  );
  const rig = gated ? await sharedRig() : null;
  const project = await makeRow(
    'project',
    sql`INSERT INTO project (team_id, key, name, rig_id) VALUES (${team}, ${`Q3UW${ws}`}, ${`${MARK} project`}, ${rig}) RETURNING id`,
  );
  const col = await makeRow(
    'column',
    sql`INSERT INTO project_column (project_id, name, position) VALUES (${project}, 'Todo', 1) RETURNING id`,
  );
  const col2 = await makeRow(
    'column',
    sql`INSERT INTO project_column (project_id, name, position, state_type, auto_assign_user_id) VALUES (${project}, 'Second', 2, ${second.stateType}, ${second.autoAssign ?? null}) RETURNING id`,
  );
  const size = await makeRow(
    'label',
    sql`INSERT INTO label (project_id, name) VALUES (${project}, 'size-small') RETURNING id`,
  );
  return { id: project, columnId: col, secondColumnId: col2, rigId: rig, labelIds: [size] };
}
async function user(suffix: string): Promise<string> {
  const id = `${MARK}-${suffix}`;
  madeUsers.push(id);
  const uname = MARK.replace(/_/g, '');
  await db.execute(
    sql`INSERT INTO "user" (id, name, username, email, email_verified) VALUES (${id}, 'Member', ${`${uname}${suffix}`}, ${`${suffix}@${uname}.example`}, true)`,
  );
  return id;
}
async function gatedIssue(p: Fixture, title: string, description: string, columnId?: number) {
  const projectRow = await getProjectById(p.id);
  if (!projectRow) throw new Error('project missing');
  const created = await withOwner(() =>
    createIssue(projectRow, {
      columnId: columnId ?? p.columnId,
      title,
      description,
      labelIds: p.labelIds,
      parentId: null,
    }),
  );
  made.issue.push(created.id);
  const row = await one<{ id: number; bead_id: string | null }>(
    sql`SELECT id, bead_id FROM issue WHERE id = ${created.id}`,
  );
  if (row.bead_id) minted.push(row.bead_id);
  return row;
}
async function refusalOf(make: () => Promise<unknown>) {
  try {
    await make();
  } catch (error) {
    return error as { status: number; message: string; code?: string };
  }
  throw new Error('a gated write was allowed that it should have refused');
}
describe('the gated update boundary', () => {
  afterEach(cleanUp);

  it('allows a gated update that carries the stored description forward, and logs it', async () => {
    const p = await fixture(true, { stateType: 'completed' });
    const card = await gatedIssue(p, 'Carry text', 'The carved baseline text.');
    const before = await board(p.id);
    const after = await withOwner(() =>
      updateIssue(card.id, { description: 'The carved baseline text. Carried forward.' }),
    );
    expect(after?.description).toBe('The carved baseline text. Carried forward.');
    expect(await board(p.id)).toMatchObject({ issues: 1, activity: before.activity + 1 });
    const action = await one<{ action: string | null }>(
      sql`SELECT action FROM issue_activity WHERE issue_id = ${card.id} AND action = 'description'`,
    );
    expect(action?.action).toBe('description');
  }, 120_000);
  it('refuses a gated update that rewrites the stored text away, ignoring any body-supplied override', async () => {
    const p = await fixture(true, { stateType: 'completed' });
    const card = await gatedIssue(p, 'Rewrite trap', 'The stored prose that stays.');
    const before = await board(p.id);
    const forged = {
      description: 'Brand new text that drops the old.',
      override: true,
      replace_description_override: true,
      description_override_grant: { authorized: true, reason: 'a body says so' },
    } as never;
    const refusal = await withOwner(() => refusalOf(() => updateIssue(card.id, forged)));
    expect([refusal.status, refusal.code]).toEqual([409, 'tracker-rules-violation']);
    expect(refusal.message).toInclude('stored description');
    const row = await one<{ description: string }>(
      sql`SELECT description FROM issue WHERE id = ${card.id}`,
    );
    expect(row.description).toBe('The stored prose that stays.');
    expect(await board(p.id)).toEqual(before);
  }, 90_000);
  it('refuses a gated move into a completed column with the close rule, writing nothing', async () => {
    const p = await fixture(true, { stateType: 'completed' });
    const card = await gatedIssue(p, 'Close needs facts', 'Not closed yet.');
    const before = await board(p.id);
    const refusal = await withOwner(() =>
      refusalOf(() => updateIssue(card.id, { columnId: p.secondColumnId })),
    );
    expect([refusal.status, refusal.code]).toEqual([409, 'tracker-rules-violation']);
    expect(refusal.message).toInclude('close_facts');
    const row = await one<{ column_id: number; assignee_user_id: string | null }>(
      sql`SELECT column_id, assignee_user_id FROM issue WHERE id = ${card.id}`,
    );
    expect([row.column_id, row.assignee_user_id]).toEqual([p.columnId, null]);
    expect(await board(p.id)).toEqual(before);
  }, 90_000);
  it('allows a title edit of a card already sitting in a completed column', async () => {
    const p = await fixture(true, { stateType: 'completed' });
    const card = await gatedIssue(
      p,
      'Done card',
      'The text the done card keeps.',
      p.secondColumnId,
    );
    const local = (card.bead_id as string).slice(RIG_PREFIX.length + 1);
    const before = await board(p.id);
    const after = await withOwner(() =>
      updateIssue(card.id, {
        title: `${local}: Done card, retitled`,
        description: 'The text the done card keeps.',
      }),
    );
    expect(after?.title).toBe(`${local}: Done card, retitled`);
    expect(after?.columnId).toBe(p.secondColumnId);
    expect(await board(p.id)).toMatchObject({ issues: 1, activity: before.activity + 1 });
  }, 90_000);
  it('refuses the auto-assignment a move into an open column carries, with no routing facts to judge it', async () => {
    const auto = await user('auto');
    const p = await fixture(true, { stateType: 'started', autoAssign: auto });
    const card = await gatedIssue(p, 'Auto assignee', 'Moved into a column that assigns.');
    const before = await board(p.id);
    const refusal = await withOwner(() =>
      refusalOf(() => updateIssue(card.id, { columnId: p.secondColumnId })),
    );
    expect([refusal.status, refusal.code]).toEqual([409, 'tracker-rules-violation']);
    expect(refusal.message).toInclude('routing_facts');
    const row = await one<{ column_id: number; assignee_user_id: string | null }>(
      sql`SELECT column_id, assignee_user_id FROM issue WHERE id = ${card.id}`,
    );
    expect([row.column_id, row.assignee_user_id]).toEqual([p.columnId, null]);
    expect(await board(p.id)).toEqual(before);
  }, 90_000);
  it('refuses a gated assignee change on its own, with no routing facts to judge it', async () => {
    const member = await user('member');
    const p = await fixture(true, { stateType: 'started' });
    await db.execute(
      sql`INSERT INTO project_member (project_id, user_id) VALUES (${p.id}, ${member})`,
    );
    const card = await gatedIssue(p, 'Assign someone', 'The card the assignee would take.');
    const before = await board(p.id);
    const refusal = await withOwner(() =>
      refusalOf(() => updateIssue(card.id, { assigneeUserId: member })),
    );
    expect([refusal.status, refusal.code]).toEqual([409, 'tracker-rules-violation']);
    expect(refusal.message).toInclude('routing_facts');
    const row = await one<{ assignee_user_id: string | null }>(
      sql`SELECT assignee_user_id FROM issue WHERE id = ${card.id}`,
    );
    expect(row.assignee_user_id).toBeNull();
    expect(await board(p.id)).toEqual(before);
  }, 90_000);
  it('judges the locked row, not the stale pool read, when a writer holds the card', async () => {
    const p = await fixture(true, { stateType: 'started' });
    const card = await gatedIssue(p, 'Stale pool', 'The description the pool saw.');
    const stale = 'The description the pool saw. Stale carry.';
    let release!: () => void;
    let startHolding!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holding = new Promise<void>((resolve) => (startHolding = resolve));
    // The holder locks and rewrites the card, holding its tx open; readiness fires after both.
    const held = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM issue WHERE id = ${card.id} FOR UPDATE`);
      await tx.execute(
        sql`UPDATE issue SET description = 'The locked rewrite.' WHERE id = ${card.id}`,
      );
      startHolding();
      await gate;
    });
    let holderError: unknown = null;
    const settled = held.catch((error) => (holderError = error));
    let refusal: Promise<unknown> | null = null;
    // Whatever fails still releases the holder and settles both sides: no hang, no unhandled
    // rejection — a mutant that allows the write must fail the case, not the process.
    try {
      await Promise.race([holding, settled]);
      if (holderError !== null) throw new Error(`holder failed: ${String(holderError)}`);
      refusal = (async () => {
        try {
          return await withOwner(() =>
            refusalOf(() => updateIssue(card.id, { description: stale })),
          );
        } catch (error) {
          return error;
        }
      })();
      // A row-lock waiter shows no ungranted relation lock, so the poll watches this database's lock waiters.
      let waiting = { n: 0 };
      for (let i = 0; i < 200; i += 1) {
        waiting = await one<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
        );
        if (waiting.n > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(waiting.n).toBeGreaterThan(0);
      release();
      const error = (await refusal) as { status: number; code?: string; message: string };
      expect([error.status, error.code]).toEqual([409, 'tracker-rules-violation']);
      expect(error.message).toInclude('stored description');
      const row = await one<{ description: string }>(
        sql`SELECT description FROM issue WHERE id = ${card.id}`,
      );
      expect(row.description).toBe('The locked rewrite.');
    } finally {
      release();
      if (refusal !== null) await refusal;
      await settled;
    }
  }, 120_000);
  it('refuses a gated update whose rule config is unset, and never spawns', async () => {
    const p = await fixture(true, { stateType: 'started' });
    const card = await gatedIssue(p, 'No config', 'The card a refused write leaves.');
    const before = await board(p.id);
    const refusal = await withNoConfig(() =>
      refusalOf(() => updateIssue(card.id, { description: 'A refused edit.' })),
    );
    expect([refusal.status, refusal.code]).toEqual([409, 'tracker-rules-unconfigured']);
    expect(refusal.message).toInclude(TRACKER_GATE_ENV.manifest);
    expect(await board(p.id)).toEqual(before);
  }, 90_000);
  it('keeps the ordinary update untouched with no rule config and a broken manifest', async () => {
    const plain = await fixture(false, { stateType: 'started' });
    const projectRow = await getProjectById(plain.id);
    if (!projectRow) throw new Error('project missing');
    const created = await createIssue(projectRow, {
      columnId: plain.columnId,
      title: 'Ordinary card',
      labelIds: plain.labelIds,
      parentId: null,
    });
    made.issue.push(created.id);
    const before = await board(plain.id);
    const updated = await withGateEnv(
      [OWNER.python, '/dev/null/nonexistent-owner.py', '/dev/null'],
      () => updateIssue(created.id, { description: 'An ordinary edit.' }),
    );
    expect(updated?.description).toBe('An ordinary edit.');
    const row = await one<{ bead_id: string | null; assignee_user_id: string | null }>(
      sql`SELECT bead_id, assignee_user_id FROM issue WHERE id = ${created.id}`,
    );
    expect([row.bead_id, row.assignee_user_id]).toEqual([null, null]);
    expect(await board(plain.id)).toMatchObject({ issues: 1, activity: before.activity + 1 });
  }, 60_000);
  it('retains exactly the fixture the schema forbids removing, and nothing else', async () => {
    expect(cleanupErrors).toEqual([]);
    expect(made.rig.length).toBe(1);
    const residue = await one<Record<string, number>>(
      sql`SELECT (SELECT count(*) FROM rig)::int AS rigs, (SELECT count(*) FROM bead_identity)::int AS identities, (SELECT count(*) FROM workspace WHERE name = ${`${MARK} ws`})::int AS ws, (SELECT count(*) FROM team WHERE name = ${`${MARK} team`})::int AS team, (SELECT count(*) FROM project WHERE name = ${`${MARK} project`})::int AS proj, (SELECT count(*) FROM "user" WHERE id LIKE ${`${MARK}%`})::int AS users`,
    );
    expect([residue.ws, residue.team, residue.proj, residue.users]).toEqual([0, 0, 0, 0]);
    expect(residue.rigs).toBe(base.rigs + 1);
    const rig = await one<{ id: number; prefix: string; next_root: number }>(
      sql`SELECT id, prefix, next_root FROM rig WHERE prefix = ${RIG_PREFIX}`,
    );
    const roots = minted.filter((token) => !token.includes('.'));
    expect([rig.prefix, rig.next_root]).toEqual([RIG_PREFIX, roots.length + 1]);
    const ledger = (await db.execute(
      sql`SELECT local_token, origin, issue_id FROM bead_identity WHERE rig_id = ${rig.id} ORDER BY local_token`,
    )) as unknown as LedgerRow[];
    const local = minted.map((token) => token.slice(RIG_PREFIX.length + 1)).sort();
    expect(ledger.length).toBe(local.length);
    expect(ledger.map((row) => row.local_token)).toEqual(local);
    expect(ledger.map((row) => row.issue_id)).toEqual(local.map(() => null));
    expect(ledger.map((row) => row.origin)).toEqual(local.map(() => 'minted'));
    expect(residue.identities).toBe(base.identities + local.length);
  }, 60_000);
});
