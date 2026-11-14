import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// The first gated create: what the shared @repo/db gate refuses on a rig-gated project, and what it leaves untouched when it does. The allocator
// suites (bead-create.test.ts) prove tokens, counters and parent links; nothing before this file asks the reviewed Python owner. This file asks it
// for real — the sanctioned interpreter, Root's reviewed owner export and its pin manifest — no mock, no stub.
//
// DATABASE HELD. Root's GO says source now, no DB run until an explicit serial GO: without the grant flag this file refuses before any client
// exists. It never calls resetDb, truncates a schema, clones or creates a database, runs a migration, provider or sender, disables a trigger, or
// deletes a rig or a ledger row.
//
// RETAINED FIXTURES, NOT ZERO RESIDUE. createIssue owns its own transaction, so a proof of this writer cannot be rolled back from the test side,
// and the schema forbids the alternative: rig_no_delete and bead_identity_no_delete (packages/db/drizzle/0181_tracker_identity.sql) refuse both,
// and deleting an issue only turns its ledger row into a tombstone. Under Root's fixture ruling this run KEEPS one named synthetic rig (prefix
// RIG_PREFIX, a UUID this process made) plus the identity tombstones its gated creates minted. Everything it may remove goes by exact id, and the
// last case states what is left: this run's rig, this run's tombstones with issue_id null, and nothing else moved.
const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const GRANT = 'ITSAPLAN_8364_D3_CREATE_PROOF';
const OWNER_CONFIG = '/Users/misty/Output/reports/8364_root_policy_owner_R2/CONFIG.json';
const MARK = 'zz_qwen3_d3u3';
// ONE shared synthetic rig for the whole proof run, shared by isolated owned projects, so the retained
// fixture stays as small as the schema allows. No real board is seeded or reused.
const RIG_PREFIX = `q3u3${randomUUID().replace(/-/g, '')}`;
type Mode = 'auto' | 'root' | 'daughter';
type Fixture = { id: number; columnId: number; rigId: number | null; labelIds: number[] };
type Residue = { rigs: number; identities: number; ws: number; team: number; proj: number };
type LedgerRow = {
  local_token: string;
  origin: string;
  root: number | null;
  issue_id: number | null;
};
function grantAndTarget(): string {
  if (process.env[GRANT] !== 'granted')
    throw new Error(
      `DB held: this suite runs only when ${GRANT}=granted is set by Root's serial DB GO`,
    );
  if (process.env.NODE_ENV !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (process.env.BUN_TEST_WORKER_ID) throw new Error('these tests run serial, with no worker id');
  const url = new URL(process.env.DATABASE_URL ?? '');
  const name = url.pathname.replace(/^\//, '');
  if (!LOOPBACK.has(url.hostname)) throw new Error(`refusing non-loopback host ${url.hostname}`);
  if ((url.port || '5433') !== '5433') throw new Error('refusing a port other than 5433');
  if (name !== REQUIRED_DB) throw new Error(`refusing ${name}; this suite uses ${REQUIRED_DB}`);
  return url.toString();
}
void grantAndTarget();

// Imported only after the guard, so no preload opens a connection.
const { db } = await import('@repo/db');
const { createIssue } = await import('../../service');
const { getProjectById } = await import('../../../projects/service');
const { TRACKER_GATE_ENV } = await import('@repo/db/tracker-gate');
const { sql } = await import('drizzle-orm');
const OWNER = JSON.parse(readFileSync(OWNER_CONFIG, 'utf8')) as Record<string, string>;

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(query)) as unknown as T[])[0];
}
async function many<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

// What this run created, remembered under these bucket names. A bucket is not always the table a row lives in (a column row lives in
// project_column), so cleanup works through the pairs below instead of guessing a table name. The rig bucket has no pair: the schema forbids it.
const BUCKETS = ['issue', 'label', 'column', 'project', 'team', 'workspace', 'rig'] as const;
type Bucket = (typeof BUCKETS)[number];
const made = Object.fromEntries(BUCKETS.map((b) => [b, [] as number[]])) as Record<
  Bucket,
  number[]
>;
const CLEANUP: [Bucket, string][] = [
  ['issue', 'issue'],
  ['label', 'label'],
  ['column', 'project_column'],
  ['project', 'project'],
  ['team', 'team'],
  ['workspace', 'workspace'],
];
const minted: string[] = [];
const cleanupErrors: string[] = [];
// Board counts before this run does anything, so the residue it retains is measured, not assumed.
const base = await one<{ identities: number; rigs: number }>(
  sql`SELECT (SELECT count(*) FROM bead_identity)::int AS identities, (SELECT count(*) FROM rig)::int AS rigs`,
);

// Every variable a case sets comes back exactly as it was, so no case erases a config the process genuinely had, and no case leaks its own config onward.
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

// A row this run made, remembered by id so cleanup reaches it by exact id and never by a filter. The bucket is typed, so a row recorded under a name
// cleanup does not know is a build error, not an afterEach surprise.
async function makeRow(bucket: Bucket, insert: ReturnType<typeof sql>): Promise<number> {
  const id = (await one<{ id: number }>(insert)).id;
  made[bucket].push(id);
  return id;
}

// The shared rig, made once per run and kept for good: its prefix is this process's UUID, its counter what the owner compares every later id against.
let rigId: number | null = null;
async function sharedRig(): Promise<number> {
  if (rigId === null)
    rigId = await makeRow('rig', sql`INSERT INTO rig (prefix) VALUES (${RIG_PREFIX}) RETURNING id`);
  return rigId;
}

// Removes only what this run may remove, by exact id, and never a rig or a ledger row. A failed delete is recorded rather than thrown, so cleanup cannot hide the failure the case found.
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
}

// The whole board one case could possibly have moved, in one query.
async function board(projectId: number, rig: number | null) {
  return one<Record<string, number>>(sql`
    SELECT (SELECT next_sequence FROM project WHERE id = ${projectId}) AS seq,
           (SELECT coalesce(next_root, 0) FROM rig WHERE id = ${rig}) AS root,
           (SELECT count(*)::int FROM issue WHERE project_id = ${projectId}) AS issues,
           (SELECT count(*)::int FROM bead_identity WHERE rig_id = ${rig}) AS identities,
           (SELECT count(*)::int FROM issue_label WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS labels,
           (SELECT count(*)::int FROM issue_activity WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS activity,
           (SELECT count(*)::int FROM notification WHERE project_id = ${projectId}) AS notifications,
           (SELECT count(*)::int FROM agent_run WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})) AS runs,
           (SELECT count(*)::int FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE project_id = ${projectId})) AS webhooks`);
}

async function fixture(gated: boolean, sizes: string[] = []): Promise<Fixture> {
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
    sql`INSERT INTO project (team_id, key, name, rig_id) VALUES (${team}, ${`Q3U3${ws}`}, ${`${MARK} project`}, ${rig}) RETURNING id`,
  );
  const column = await makeRow(
    'column',
    sql`INSERT INTO project_column (project_id, name, position) VALUES (${project}, 'Todo', 1) RETURNING id`,
  );
  const labelIds: number[] = [];
  for (const name of sizes)
    labelIds.push(
      await makeRow(
        'label',
        sql`INSERT INTO label (project_id, name) VALUES (${project}, ${name}) RETURNING id`,
      ),
    );
  return { id: project, columnId: column, rigId: rig, labelIds };
}

async function create(p: Fixture, title: string, parentId?: number, mode?: Mode) {
  const projectRow = await getProjectById(p.id);
  if (!projectRow) throw new Error('project missing');
  const created = await createIssue(projectRow, {
    columnId: p.columnId,
    title,
    labelIds: p.labelIds,
    parentId: parentId ?? null,
    beadAllocationMode: mode,
  });
  made.issue.push(created.id);
  const row = await one<{
    id: number;
    bead_id: string | null;
    title: string;
    parent_id: number | null;
  }>(sql`SELECT id, bead_id, title, parent_id FROM issue WHERE id = ${created.id}`);
  if (row.bead_id) minted.push(row.bead_id);
  return row;
}

// The refusal an API caller actually receives: createIssue maps each shared @repo/db refusal to its own HttpError, so these cases assert the mapped shape, not the internal error type.
async function refusalOf(make: () => Promise<unknown>) {
  try {
    await make();
  } catch (error) {
    return error as { status: number; message: string; code?: string };
  }
  throw new Error('a gated write was allowed that it should have refused');
}

describe('the gated create boundary', () => {
  afterEach(cleanUp);

  it('refuses a gated create with no size label and moves nothing on the board', async () => {
    const p = await fixture(true);
    const before = await board(p.id, p.rigId);
    const refusal = await withOwner(() => refusalOf(() => create(p, 'No size here')));
    expect([refusal.status, refusal.code]).toEqual([409, 'tracker-rules-violation']);
    expect(refusal.message).toInclude('size');
    expect(refusal.message.toLowerCase()).toInclude('size-small');
    expect(await board(p.id, p.rigId)).toEqual(before);
    expect([before.issues, before.seq]).toEqual([0, 1]);
  }, 60_000);

  it('refuses two different sizes on one create with every violation carried', async () => {
    const p = await fixture(true, ['size-small', 'size-large']);
    const before = await board(p.id, p.rigId);
    const refusal = await withOwner(() => refusalOf(() => create(p, 'Two sizes')));
    expect([refusal.status, refusal.code]).toEqual([409, 'tracker-rules-violation']);
    expect(refusal.message).toInclude('size');
    expect(await board(p.id, p.rigId)).toEqual(before);
  }, 60_000);

  it('refuses a gated project whose rule config is unset, and never spawns', async () => {
    const p = await fixture(true, ['size-small']);
    const before = await board(p.id, p.rigId);
    const refusal = await withNoConfig(() => refusalOf(() => create(p, 'No config')));
    expect([refusal.status, refusal.code]).toEqual([409, 'tracker-rules-unconfigured']);
    expect(refusal.message).toInclude(TRACKER_GATE_ENV.manifest);
    expect(await board(p.id, p.rigId)).toEqual(before);
  }, 60_000);

  it('refuses a manifest that does not pin the owner it was handed', async () => {
    const p = await fixture(true, ['size-small']);
    const before = await board(p.id, p.rigId);
    const refusal = await withGateEnv([OWNER.python, OWNER.owner, '/dev/null'], () =>
      refusalOf(() => create(p, 'Bad manifest')),
    );
    expect(refusal.status).toBe(409);
    expect(refusal.code).not.toBe('tracker-rules-violation');
    expect(await board(p.id, p.rigId)).toEqual(before);
  }, 60_000);

  it("allows one gated create with exactly one size, with the owner's own id rule satisfied", async () => {
    const p = await fixture(true, ['size-small']);
    const before = await board(p.id, p.rigId);
    const row = await withOwner(() => create(p, 'One size'));
    // The owner's id rule is part of the allow: it compares the id the allocator minted with the one it would
    // have chosen from the snapshot, so an allow means the two agreed. The counter belongs to the shared rig.
    const expected = `${RIG_PREFIX}-${before.root}`;
    expect([row.bead_id, row.title]).toEqual([expected, `${before.root}: One size`]);
    expect(await board(p.id, p.rigId)).toMatchObject({
      issues: 1,
      identities: before.identities + 1,
      seq: before.seq + 1,
      root: before.root + 1,
    });
    const names = (
      await one<{
        names: string[];
      }>(sql`SELECT coalesce(array_agg(l.name ORDER BY l.name), '{}') AS names
      FROM issue_label il JOIN label l ON l.id = il.label_id WHERE il.issue_id = ${row.id}`)
    ).names;
    expect(names).toEqual(['size-small']);
  }, 90_000);

  it('keeps the ordinary path untouched with no rule config and a broken manifest', async () => {
    const plain = await fixture(false, ['size-small']);
    const row = await withNoConfig(() => create(plain, 'Ordinary card'));
    const broken = await withGateEnv(
      [OWNER.python, '/dev/null/nonexistent-owner.py', '/dev/null'],
      () => create(plain, 'Broken config'),
    );
    expect([row.title, row.bead_id, broken.title, broken.bead_id]).toEqual([
      'Ordinary card',
      null,
      'Broken config',
      null,
    ]);
    expect(await board(plain.id, null)).toMatchObject({ issues: 2, identities: 0 });
  }, 60_000);

  it('refuses a daughter under an issue that holds no bead identity, writing nothing', async () => {
    // A project gated after the fact: the older card came from the ordinary path, so the ledger holds nothing
    // for it. The snapshot sees that before any number is reserved, and the answer stays the caller's 409.
    const late = await fixture(false, ['size-small']);
    const legacy = await create(late, 'Legacy parent');
    expect(legacy.bead_id).toBeNull();
    const rig = await sharedRig();
    await db.execute(sql`UPDATE project SET rig_id = ${rig} WHERE id = ${late.id}`);
    const gatedRow = await getProjectById(late.id);
    if (!gatedRow) throw new Error('project missing');
    const before = await board(late.id, rig);
    const error = await withOwner(() =>
      refusalOf(() =>
        createIssue(gatedRow, {
          columnId: late.columnId,
          title: 'Child of a legacy card',
          labelIds: late.labelIds,
          parentId: legacy.id,
        }),
      ),
    );
    expect([error.status, error.code]).toEqual([409, 'parent-without-identity']);
    expect(error.message).toInclude('holds no bead identity');
    expect(await board(late.id, rig)).toEqual(before);
    expect([before.issues, before.identities]).toEqual([1, minted.length]);
  }, 90_000);

  it('sends the parent and mode facts the owner agrees with, on root, daughter and auto', async () => {
    const p = await fixture(true, ['size-small']);
    const before = await board(p.id, p.rigId);
    const root = await withOwner(() => create(p, 'Root card'));
    const daughter = await withOwner(() => create(p, 'Daughter card', root.id));
    const forced = await withOwner(() => create(p, 'Forced root', root.id, 'root'));
    // Same facts the owner is given: the parent's real link, and the mode the caller named.
    expect([daughter.parent_id, forced.parent_id]).toEqual([root.id, root.id]);
    expect(daughter.title.includes('.')).toBe(true);
    expect(forced.title.includes('.')).toBe(false);
    expect(await board(p.id, p.rigId)).toMatchObject({
      issues: before.issues + 3,
      identities: before.identities + 3,
    });
  }, 120_000);

  it('ignores any identity or mode fact a caller tries to put in the write', async () => {
    const p = await fixture(true, ['size-small']);
    const before = await board(p.id, p.rigId);
    const projectRow = await getProjectById(p.id);
    if (!projectRow) throw new Error('project missing');
    // None of these are fields the writer reads: the input's own names are parentId and beadAllocationMode.
    const forged = {
      columnId: p.columnId,
      title: 'Forged facts',
      labelIds: p.labelIds,
      id: `${RIG_PREFIX}-999999`,
      beadId: `${RIG_PREFIX}-999999`,
      parent_id: 999999,
      rig_prefix: 'other-rig',
      root_high_water: 999999,
      existing_ids: [`${RIG_PREFIX}-999999`],
      id_mode: 'daughter',
    };
    const row = await withOwner(async () => {
      const created = await createIssue(projectRow, forged as never);
      made.issue.push(created.id);
      return one<{ bead_id: string | null; title: string; parent_id: number | null }>(
        sql`SELECT bead_id, title, parent_id FROM issue WHERE id = ${created.id}`,
      );
    });
    // The token, prefix, rig and counters all come from the transaction, never from the body.
    const expected = `${RIG_PREFIX}-${before.root}`;
    if (row.bead_id) minted.push(row.bead_id);
    expect([row.bead_id, row.parent_id]).toEqual([expected, null]);
    expect(row.title).toBe(`${before.root}: Forged facts`);
    const after = await board(p.id, p.rigId);
    expect([after.identities, after.root]).toEqual([before.identities + 1, before.root + 1]);
  }, 90_000);

  it('retains exactly the fixture the schema forbids removing, and nothing else', async () => {
    // Root's fixture ruling: one named synthetic rig plus the tombstones its gated creates minted, and
    // everything the run was allowed to remove gone by exact id.
    expect(cleanupErrors).toEqual([]);
    expect(made.rig.length).toBe(1);
    const residue = await one<Residue>(sql`SELECT (SELECT count(*) FROM rig)::int AS rigs,
             (SELECT count(*) FROM bead_identity)::int AS identities,
             (SELECT count(*) FROM workspace WHERE name = ${`${MARK} ws`})::int AS ws, (SELECT count(*) FROM team WHERE name = ${`${MARK} team`})::int AS team,
             (SELECT count(*) FROM project WHERE name = ${`${MARK} project`})::int AS proj`);
    expect([residue.ws, residue.team, residue.proj]).toEqual([0, 0, 0]);
    expect(residue.rigs).toBe(base.rigs + 1);
    const rig = await one<{ id: number; prefix: string; next_root: number }>(
      sql`SELECT id, prefix, next_root FROM rig WHERE prefix = ${RIG_PREFIX}`,
    );
    const roots = minted.filter((token) => !token.includes('.'));
    expect([rig.prefix, rig.next_root]).toEqual([RIG_PREFIX, roots.length + 1]);
    // The retained ledger read row by row: this run's count, the tokens the allocator really wrote, and every
    // link turned to null. No ledger row outside this run's own tokens moved at all.
    const ledger = await many<LedgerRow>(
      sql`SELECT local_token, origin, root, issue_id FROM bead_identity WHERE rig_id = ${rig.id}
        ORDER BY local_token`,
    );
    const local = minted.map((token) => token.slice(RIG_PREFIX.length + 1)).sort();
    expect(ledger.length).toBe(local.length);
    expect(ledger.map((row) => row.local_token)).toEqual(local);
    expect(ledger.map((row) => row.issue_id)).toEqual(local.map(() => null));
    expect(ledger.map((row) => row.origin)).toEqual(local.map(() => 'minted'));
    expect(ledger.map((row) => row.root)).toEqual(local.map((t) => Number(t.split('.')[0])));
    expect(residue.identities).toBe(base.identities + local.length);
  }, 60_000);
});
