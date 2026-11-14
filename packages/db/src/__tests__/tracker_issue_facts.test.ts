// 8364 D3 U2 real-database tests for snapshotIdFacts, the shared pre-allocation identity
// snapshot: a pure read through the caller's executor. Run from packages/db, serial:
// bun test --env-file=/dev/null src/__tests__/tracker_issue_facts.test.ts. DATABASE_URL must be
// the owned itsaplan_8364_d2_test on 127.0.0.1:5433 with NODE_ENV=test. The guard runs before
// any client is created, so a refused target never opens a pool.
//
// WHY every fixture lives inside a transaction that is always rolled back: migration 0181 makes
// rig and bead_identity rows undeletable (rig_no_delete, bead_identity_no_delete), so a committed
// fixture would stay in the database for good. snapshotIdFacts takes the caller's executor, so
// each case builds its whole board inside its own transaction, reads it there, and aborts.
// Nothing is committed, and the baseline check proves every owned table ends where it began.

import { afterAll, beforeAll, expect, it } from 'bun:test';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema';
import type { DbExecutor } from '../client';

const REQUIRED_DB = 'itsaplan_8364_d2_test';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function targetUrl(raw: string | undefined, nodeEnv: string | undefined): string {
  if (nodeEnv !== 'test') throw new Error('these tests run only with NODE_ENV=test');
  if (process.env.BUN_TEST_WORKER_ID)
    throw new Error('these tests run in a single process; BUN_TEST_WORKER_ID must be unset');
  if (!raw) throw new Error('DATABASE_URL is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL does not parse');
  }
  const name = url.pathname.replace(/^\//, '');
  const port = url.port || '5432';
  if (!LOOPBACK_HOSTS.has(url.hostname))
    throw new Error(`refusing non-loopback host ${url.hostname}`);
  if (port !== '5433') throw new Error(`refusing port ${port}; this suite uses 5433`);
  if (name !== REQUIRED_DB)
    throw new Error(`refusing database ${name}; this suite uses ${REQUIRED_DB}`);
  return raw;
}

const url = targetUrl(process.env.DATABASE_URL, process.env.NODE_ENV);

// Imported only after the target is proven, so a refused target creates no pool.
const { snapshotIdFacts, IdFactsRefusal } = await import('../tracker-issue-facts');

// Two independent connections: the primary runs each case's transaction, and the second must
// not see that transaction's uncommitted rows, which is what makes the isolation case real.
const client = postgres(url, { max: 1, onnotice: () => undefined });
const testDb = drizzle(client, { schema });
const poolClient = postgres(url, { max: 1, onnotice: () => undefined });
const poolDb = drizzle(poolClient, { schema });

const ROLLBACK = Symbol('rollback');
async function rolledBack(fn: (tx: DbExecutor) => Promise<void>): Promise<void> {
  try {
    await testDb.transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

// A per-run marker so every unique string this suite writes is its own.
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const PREFIX = `ctfact${RUN}`;
const OTHER_PREFIX = `ctfact${RUN}b`;

async function insertId(ex: DbExecutor, query: ReturnType<typeof sql>): Promise<number> {
  const [r] = (await ex.execute(query)) as unknown as { id: number | string }[];
  return Number(r.id);
}

async function insertIdentity(
  ex: DbExecutor,
  rigId: number,
  localToken: string,
  root: number | null,
  child: number | null,
  origin: string,
  issueId: number | null,
): Promise<void> {
  await ex.execute(
    sql`INSERT INTO bead_identity (rig_id, local_token, root, child, origin, issue_id)
        VALUES (${rigId}, ${localToken}, ${root}, ${child}, ${origin}, ${issueId})`,
  );
}

// One board, built inside the caller's transaction: a rig (next_root 42) shared by projects A
// and B, a second rig (next_root 7) gating project C, a parent with an identity in each of A and
// B, an A issue whose identity sits on the other rig, an A issue with no identity, and a daughter
// tombstone. Issue sequence numbers are distinct within each project.
async function seed(tx: DbExecutor) {
  const workspace = await insertId(
    tx,
    sql`INSERT INTO workspace (name) VALUES (${`ws_${RUN}`}) RETURNING id`,
  );
  const team = await insertId(
    tx,
    sql`INSERT INTO team (workspace_id, name) VALUES (${workspace}, ${`team_${RUN}`}) RETURNING id`,
  );
  const rig = await insertId(
    tx,
    sql`INSERT INTO rig (prefix, next_root) VALUES (${PREFIX}, 42) RETURNING id`,
  );
  const otherRig = await insertId(
    tx,
    sql`INSERT INTO rig (prefix, next_root) VALUES (${OTHER_PREFIX}, 7) RETURNING id`,
  );
  const project = (key: string, rigId: number) =>
    insertId(
      tx,
      sql`INSERT INTO project (team_id, key, name, rig_id)
          VALUES (${team}, ${key}, ${`proj_${key}`}, ${rigId}) RETURNING id`,
    );
  const projectA = await project(`ka_${RUN}`, rig);
  const projectB = await project(`kb_${RUN}`, rig);
  const projectC = await project(`kc_${RUN}`, otherRig);
  const column = (projectId: number) =>
    insertId(
      tx,
      sql`INSERT INTO project_column (project_id, name, position)
          VALUES (${projectId}, ${`col_${RUN}`}, 1) RETURNING id`,
    );
  const colA = await column(projectA);
  const colB = await column(projectB);
  const issue = (projectId: number, columnId: number, seq: number, title: string) =>
    insertId(
      tx,
      sql`INSERT INTO issue (project_id, sequence_number, column_id, title)
          VALUES (${projectId}, ${seq}, ${columnId}, ${`${title}_${RUN}`}) RETURNING id`,
    );
  const parentA = await issue(projectA, colA, 1, 'parentA');
  const otherRigIssue = await issue(projectA, colA, 2, 'otherRig');
  const noIdentity = await issue(projectA, colA, 3, 'noId');
  const parentB = await issue(projectB, colB, 1, 'parentB');
  await insertIdentity(tx, rig, '7', 7, 0, 'minted', parentA);
  await insertIdentity(tx, rig, '7.1', 7, 1, 'minted', null);
  await insertIdentity(tx, rig, 'hashA1', null, null, 'imported', parentB);
  await insertIdentity(tx, otherRig, '9', 9, 0, 'imported', otherRigIssue);
  return {
    rig,
    otherRig,
    projectA,
    projectB,
    projectC,
    parentA,
    parentB,
    otherRigIssue,
    noIdentity,
  };
}

async function refusalCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof IdFactsRefusal) return error.code;
    throw error;
  }
}

// Row counts of every table a case writes, read on the second connection before and after the
// suite: the forced aborts must leave each one exactly where it began.
const OWNED_TABLES = [
  'workspace',
  'team',
  'rig',
  'project',
  'project_column',
  'issue',
  'bead_identity',
];
async function baseline(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of OWNED_TABLES) {
    const [r] = await poolClient`SELECT count(*)::int AS n FROM ${poolClient(table)}`;
    out[table] = r.n as number;
  }
  return out;
}

let before: Record<string, number> = {};
beforeAll(async () => {
  before = await baseline();
});

afterAll(async () => {
  try {
    expect(await baseline()).toEqual(before);
    const [left] =
      await poolClient`SELECT count(*)::int AS n FROM rig WHERE prefix IN (${PREFIX}, ${OTHER_PREFIX})`;
    expect(left.n).toBe(0);
  } finally {
    await client.end();
    await poolClient.end();
  }
});

it('reads the actual pre-state through a supplied transaction', async () => {
  // next_root is 42 while the highest stored root is 7: root_high_water is the stored counter
  // minus one (41), never a number derived from the rows or from a candidate id.
  await rolledBack(async (tx) => {
    const f = await seed(tx);
    const facts = await snapshotIdFacts(tx, {
      rigId: f.rig,
      projectId: f.projectA,
      parentIssueId: null,
    });
    expect(facts.rig_prefix).toBe(PREFIX);
    expect(facts.root_high_water).toBe(41);
    expect(facts.parent_id).toBeNull();
    expect([...facts.existing_ids].sort()).toEqual(
      [`${PREFIX}-7`, `${PREFIX}-7.1`, `${PREFIX}-hashA1`].sort(),
    );
  });
});

it('returns the parent id read by issue id, verbatim', async () => {
  await rolledBack(async (tx) => {
    const f = await seed(tx);
    const root = await snapshotIdFacts(tx, {
      rigId: f.rig,
      projectId: f.projectA,
      parentIssueId: f.parentA,
    });
    expect(root.parent_id).toBe(`${PREFIX}-7`);
    // A shared rig: project B's imported hash parent keeps its exact text.
    const hash = await snapshotIdFacts(tx, {
      rigId: f.rig,
      projectId: f.projectB,
      parentIssueId: f.parentB,
    });
    expect(hash.parent_id).toBe(`${PREFIX}-hashA1`);
    expect(hash.existing_ids).toEqual(root.existing_ids);
  });
});

it('keeps over 100 tombstones and imported hash and multidot tokens, unfiltered', async () => {
  const bulk: { token: string; root: number | null; child: number | null; origin: string }[] = [];
  for (let root = 200; root < 260; root += 1)
    bulk.push({ token: `${root}`, root, child: 0, origin: 'minted' });
  for (let h = 1; h <= 40; h += 1)
    bulk.push({ token: `hashX${h}`, root: null, child: null, origin: 'imported' });
  for (let d = 1; d <= 20; d += 1)
    bulk.push({ token: `m${d}.2.1`, root: null, child: null, origin: 'imported' });
  expect(bulk.length).toBeGreaterThan(100);
  await rolledBack(async (tx) => {
    const f = await seed(tx);
    for (const b of bulk) await insertIdentity(tx, f.rig, b.token, b.root, b.child, b.origin, null);
    const facts = await snapshotIdFacts(tx, {
      rigId: f.rig,
      projectId: f.projectA,
      parentIssueId: null,
    });
    const expected = [`${PREFIX}-7`, `${PREFIX}-7.1`, `${PREFIX}-hashA1`].concat(
      bulk.map((b) => `${PREFIX}-${b.token}`),
    );
    expect([...facts.existing_ids].sort()).toEqual(expected.sort());
    // The other rig's identity is never borrowed into this rig's inventory.
    expect(facts.existing_ids).not.toContain(`${PREFIX}-9`);
  });
});

it('refuses a wrong-project, wrong-rig, identity-less or missing parent', async () => {
  await rolledBack(async (tx) => {
    const f = await seed(tx);
    const code = (parentIssueId: number) =>
      refusalCode(() =>
        snapshotIdFacts(tx, { rigId: f.rig, projectId: f.projectA, parentIssueId }),
      );
    expect(await code(f.parentB)).toBe('parent-other-project');
    expect(await code(f.otherRigIssue)).toBe('parent-other-rig');
    expect(await code(f.noIdentity)).toBe('parent-without-identity');
    const [{ id: missing }] = (await tx.execute(
      sql`SELECT COALESCE(MAX(id), 0) + 1000 AS id FROM issue`,
    )) as unknown as { id: number }[];
    expect(await code(Number(missing))).toBe('parent-without-identity');
  });
});

it('refuses a missing rig, a missing project, a mismatched rig and bad arguments', async () => {
  await rolledBack(async (tx) => {
    const f = await seed(tx);
    const run = (input: Parameters<typeof snapshotIdFacts>[1]) =>
      refusalCode(() => snapshotIdFacts(tx, input));
    const [{ rig: noRig, project: noProject }] = (await tx.execute(
      sql`SELECT (SELECT COALESCE(MAX(id), 0) + 1000 FROM rig) AS rig,
                 (SELECT COALESCE(MAX(id), 0) + 1000 FROM project) AS project`,
    )) as unknown as { rig: number; project: number }[];
    expect(await run({ rigId: Number(noRig), projectId: f.projectA, parentIssueId: null })).toBe(
      'missing-rig',
    );
    expect(await run({ rigId: f.rig, projectId: Number(noProject), parentIssueId: null })).toBe(
      'missing-project',
    );
    expect(await run({ rigId: f.rig, projectId: f.projectC, parentIssueId: null })).toBe(
      'project-rig-mismatch',
    );
    expect(await run({ rigId: 0, projectId: f.projectA, parentIssueId: null })).toBe(
      'invalid-argument',
    );
  });
});

it('sees an uncommitted counter and identity on its transaction that a second connection cannot', async () => {
  let rigId = 0;
  await rolledBack(async (tx) => {
    const f = await seed(tx);
    rigId = f.rig;
    await tx.execute(sql`UPDATE rig SET next_root = 50 WHERE id = ${f.rig}`);
    await insertIdentity(tx, f.rig, '100', 100, 0, 'minted', null);
    const onTx = await snapshotIdFacts(tx, {
      rigId: f.rig,
      projectId: f.projectA,
      parentIssueId: null,
    });
    expect(onTx.root_high_water).toBe(49);
    expect(onTx.existing_ids).toContain(`${PREFIX}-100`);
    // The rig exists only inside the open transaction, so the second connection finds no rig.
    expect(
      await refusalCode(() =>
        snapshotIdFacts(poolDb, { rigId: f.rig, projectId: f.projectA, parentIssueId: null }),
      ),
    ).toBe('missing-rig');
  });
  // After the forced abort the rig is gone for every connection.
  expect(rigId).toBeGreaterThan(0);
  const [gone] = await poolClient`SELECT count(*)::int AS n FROM rig WHERE id = ${rigId}`;
  expect(gone.n).toBe(0);
});

it('writes nothing: counter and inventory are unchanged by a read', async () => {
  await rolledBack(async (tx) => {
    const f = await seed(tx);
    const state = async () =>
      (
        (await tx.execute(
          sql`SELECT (SELECT next_root FROM rig WHERE id = ${f.rig}) AS next_root,
                   (SELECT count(*)::int FROM bead_identity WHERE rig_id = ${f.rig}) AS n`,
        )) as unknown as { next_root: number; n: number }[]
      )[0];
    const pre = await state();
    await snapshotIdFacts(tx, { rigId: f.rig, projectId: f.projectA, parentIssueId: f.parentA });
    await snapshotIdFacts(tx, { rigId: f.rig, projectId: f.projectA, parentIssueId: null });
    expect(await state()).toEqual(pre);
  });
});
