import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';

// The create path against the owned C4 database: no shared preload, no resetDb, exact ids only.
const REQUIRED_DB = 'itsaplan_8364_c4_test';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// The guard runs before any client exists; the database modules are imported after it.
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
void targetUrl(process.env.DATABASE_URL, process.env.NODE_ENV);

const { db } = await import('@repo/db');
const { createIssue } = await import('../../service');
const { getProjectById } = await import('../../../projects/service');
const { createIssueBody } = await import('../../model');
const { Elysia } = await import('elysia');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const made = {
  issue: [] as number[],
  column: [] as number[],
  project: [] as number[],
  team: [] as number[],
  workspace: [] as number[],
  rig: [] as number[],
};

// A lock holder from the same pool, so the service's own transaction takes another connection and
// really waits. The two promises are the handshake: one says the lock is held, one releases it.
async function holdRow(lock: (tx: Tx) => Promise<unknown>) {
  let locked!: () => void;
  let release!: () => void;
  const held = new Promise<void>((r) => (locked = r));
  const open = new Promise<void>((r) => (release = r));
  const done = db.transaction(async (tx) => {
    await lock(tx);
    locked();
    await open;
  });
  await held;
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

// Waits for a genuinely blocked backend, so no case depends on a fixed sleep.
async function waitForBlocked(timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  const blocked = sql`SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
  while (Date.now() - started < timeoutMs) {
    if ((await one<{ n: number }>(blocked)).n > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no blocked backend appeared');
}

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await db.execute(query)) as unknown as T[];
  return rows[0];
}

async function project(gated: boolean) {
  const ws = await one<{ id: number }>(
    sql`INSERT INTO workspace (name) VALUES ('c4b2 ws') RETURNING id`,
  );
  made.workspace.push(ws.id);
  const team = await one<{ id: number }>(
    sql`INSERT INTO team (workspace_id, name, slug) VALUES (${ws.id}, 'c4b2 team', ${`c4b2-${ws.id}`}) RETURNING id`,
  );
  made.team.push(team.id);
  let rigId: number | null = null;
  if (gated) {
    const rig = await one<{ id: number }>(
      sql`INSERT INTO rig (prefix) VALUES (${`c4b2-${ws.id}`}) RETURNING id`,
    );
    made.rig.push(rig.id);
    rigId = rig.id;
  }
  const row = await one<{ id: number }>(
    sql`INSERT INTO project (team_id, key, name, rig_id) VALUES (${team.id}, ${`C4B2${ws.id}`}, 'c4b2 project', ${rigId}) RETURNING id`,
  );
  made.project.push(row.id);
  const column = await one<{ id: number }>(
    sql`INSERT INTO project_column (project_id, name, position) VALUES (${row.id}, 'Todo', 1) RETURNING id`,
  );
  made.column.push(column.id);
  return { id: row.id, columnId: column.id, rigId };
}

async function cleanUp(): Promise<void> {
  const drop = async (table: string, ids: number[]) => {
    for (const id of ids.splice(0))
      await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE id = ${id}`);
  };
  await drop('issue', made.issue);
  await drop('project_column', made.column);
  await drop('project', made.project);
  await drop('team', made.team);
  await drop('workspace', made.workspace);
}

// The stored facts in one query: what this file asserts is what the database holds.
async function stored(projectId: number, rigId: number | null) {
  return one<{
    seq: number;
    issues: number;
    ledger: number;
    titles: string[];
    tokens: string[];
  }>(sql`
    SELECT (SELECT next_sequence FROM project WHERE id = ${projectId}) AS seq,
           (SELECT count(*)::int FROM issue WHERE project_id = ${projectId}) AS issues,
           (SELECT count(*)::int FROM bead_identity WHERE rig_id = ${rigId}) AS ledger,
           (SELECT coalesce(array_agg(title ORDER BY id), '{}') FROM issue WHERE project_id = ${projectId}) AS titles,
           (SELECT coalesce(array_agg(bead_id ORDER BY id), '{}') FROM issue WHERE project_id = ${projectId} AND bead_id IS NOT NULL) AS tokens`);
}

async function createAt(
  projectId: number,
  columnId: number,
  title: string,
  parentId?: number,
  mode?: 'auto' | 'root' | 'daughter',
) {
  const projectRow = await getProjectById(projectId);
  if (!projectRow) throw new Error('project missing');
  const created = await createIssue(projectRow, {
    columnId,
    title,
    parentId: parentId ?? null,
    beadAllocationMode: mode,
    labelIds: [],
  });
  made.issue.push(created.id);
  return one<{ id: number; bead_id: string | null; title: string; parent_id: number | null }>(
    sql`SELECT id, bead_id, title, parent_id FROM issue WHERE id = ${created.id}`,
  );
}

describe('the create path', () => {
  it('takes a token, prefixes the title and shares one counter across two projects', async () => {
    try {
      const p = await project(true);
      await createAt(p.id, p.columnId, 'First card');
      await createAt(p.id, p.columnId, 'Second card');
      const second = await project(true);
      await db.execute(sql`UPDATE project SET rig_id = ${p.rigId} WHERE id = ${second.id}`);
      const fromOther = await createAt(second.id, second.columnId, 'From the other project');
      const rows = await stored(p.id, p.rigId);
      expect(rows.titles).toEqual(['1: First card', '2: Second card']);
      expect(fromOther.title).toBe('3: From the other project');
      expect(rows.ledger).toBe(3);
    } finally {
      await cleanUp();
    }
  }, 30_000);

  it('gives a daughter the parent root, a granddaughter its own root, and honours an explicit mode', async () => {
    try {
      const p = await project(true);
      const root = await createAt(p.id, p.columnId, 'Root');
      const daughter = await createAt(p.id, p.columnId, 'Daughter', root.id);
      const grandchild = await createAt(p.id, p.columnId, 'Grandchild', daughter.id);
      expect([daughter.title, grandchild.title, grandchild.parent_id]).toEqual([
        '1.1: Daughter',
        '2: Grandchild',
        daughter.id,
      ]);
      // An explicit root under a parent mints a fresh root and keeps the parent.
      const forced = await createAt(p.id, p.columnId, 'Explicit root', root.id, 'root');
      expect([forced.title, forced.parent_id]).toEqual(['3: Explicit root', root.id]);
      // A daughter of a daughter cannot take a daughter, and no two-part id is minted.
      await expect(
        createAt(p.id, p.columnId, 'Under a daughter', daughter.id, 'daughter'),
      ).rejects.toThrow(/cannot take a daughter/);
      expect(grandchild.title.includes('.')).toBe(false);
      // The public schema takes the three names and refuses anything else.
      const probe = new Elysia().post('/p', ({ body }) => body, { body: createIssueBody });
      const ask = (mode: string) =>
        probe
          .handle(
            new Request('http://localhost/p', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ columnId: 1, title: 'x', beadAllocationMode: mode }),
            }),
          )
          .then((r) => r.status);
      expect([
        await ask('auto'),
        await ask('root'),
        await ask('daughter'),
        await ask('sibling'),
      ]).toEqual([200, 200, 200, 422]);
    } finally {
      await cleanUp();
    }
  }, 40_000);

  it('allows a chain deeper than eight', async () => {
    try {
      const p = await project(true);
      let parentId = (await createAt(p.id, p.columnId, 'Level 1')).id;
      for (let level = 2; level <= 10; level += 1)
        parentId = (await createAt(p.id, p.columnId, `Level ${level}`, parentId)).id;
      expect((await stored(p.id, p.rigId)).issues).toBe(10);
    } finally {
      await cleanUp();
    }
  }, 60_000);
  it('keeps its title, writes no bead id and moves the native counter by one', async () => {
    try {
      const gated = await project(true);
      const plain = await project(false);
      const before = await stored(plain.id, null);
      await createAt(plain.id, plain.columnId, 'Plain card');
      await createAt(gated.id, gated.columnId, 'Gated card');
      expect(await stored(plain.id, null)).toMatchObject({
        titles: ['Plain card'],
        tokens: [],
        seq: before.seq + 1,
        ledger: 0,
      });
      expect((await stored(gated.id, gated.rigId)).seq).toBe(2);
    } finally {
      await cleanUp();
    }
  }, 30_000);
  it('refuses a foreign parent and a parent with no identity, writing nothing', async () => {
    try {
      const a = await project(true);
      const b = await project(true);
      const foreign = await createAt(b.id, b.columnId, 'Foreign parent');
      const aRow = await getProjectById(a.id);
      if (!aRow) throw new Error('project missing');
      const beforeA = await stored(a.id, a.rigId);
      await expect(
        createIssue(aRow, {
          columnId: a.columnId,
          title: 'Cross',
          parentId: foreign.id,
          labelIds: [],
        }),
      ).rejects.toThrow(/Parent must belong to this project/);
      expect(await stored(a.id, a.rigId)).toMatchObject({ seq: beforeA.seq, issues: 0, ledger: 0 });
      // Gated after the fact: the older issue has no ledger row, so a child under it cannot be
      // given a token and the allocation already taken must come back.
      const late = await project(false);
      const legacy = await createAt(late.id, late.columnId, 'Legacy parent');
      const rig = await one<{ id: number }>(
        sql`INSERT INTO rig (prefix) VALUES (${`c4b2-late-${late.id}`}) RETURNING id`,
      );
      made.rig.push(rig.id);
      await db.execute(sql`UPDATE project SET rig_id = ${rig.id} WHERE id = ${late.id}`);
      const lateRow = await getProjectById(late.id);
      if (!lateRow) throw new Error('project missing');
      const beforeLate = await stored(late.id, rig.id);
      await expect(
        createIssue(lateRow, {
          columnId: late.columnId,
          title: 'Child',
          parentId: legacy.id,
          labelIds: [],
        }),
      ).rejects.toThrow(/holds no bead identity/);
      expect(await stored(late.id, rig.id)).toMatchObject({
        seq: beforeLate.seq,
        issues: 1,
        ledger: 0,
      });
    } finally {
      await cleanUp();
    }
  }, 40_000);

  it('a failure after the ledger write rolls everything back', async () => {
    try {
      const p = await project(true);
      const nonce = `c4b2_proof_${Date.now()}`;
      await db.execute(sql`CREATE OR REPLACE FUNCTION ${sql.raw(nonce)}() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'c4b2 proof failure after ledger write'; END; $$ LANGUAGE plpgsql`);
      await db.execute(sql`CREATE CONSTRAINT TRIGGER ${sql.raw(nonce)} AFTER INSERT ON bead_identity
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${sql.raw(nonce)}()`);
      try {
        const projectRow = await getProjectById(p.id);
        if (!projectRow) throw new Error('project missing');
        const before = await stored(p.id, p.rigId);
        const rootBefore = await one<{ next_root: number }>(
          sql`SELECT next_root FROM rig WHERE id = ${p.rigId}`,
        );
        await expect(
          createIssue(projectRow, { columnId: p.columnId, title: 'Will roll back', labelIds: [] }),
        ).rejects.toThrow(/proof failure after ledger write/);
        expect(await stored(p.id, p.rigId)).toMatchObject({
          seq: before.seq,
          issues: 0,
          ledger: 0,
        });
        expect(
          (await one<{ next_root: number }>(sql`SELECT next_root FROM rig WHERE id = ${p.rigId}`))
            .next_root,
        ).toBe(rootBefore.next_root);
        expect((await one<{ ok: number }>(sql`SELECT 1 AS ok`)).ok).toBe(1);
      } finally {
        // Drop only this file's own trigger and function; no guard is disabled at any point.
        await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(nonce)} ON bead_identity`);
        await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.raw(nonce)}()`);
      }
    } finally {
      await cleanUp();
    }
  }, 60_000);
  it('refuses a gated move and an ordinary create that raced into a gated project', async () => {
    try {
      // Phase 1: hold the rig, start a gated create, move the project, release.
      const gated = await project(true);
      const other = await one<{ id: number }>(
        sql`INSERT INTO rig (prefix) VALUES (${`c4b2-race-${gated.id}`}) RETURNING id`,
      );
      made.rig.push(other.id);
      const gatedRow = await getProjectById(gated.id);
      if (!gatedRow) throw new Error('project missing');
      const rigHeld = await holdRow((tx) =>
        tx.execute(sql`SELECT id FROM rig WHERE id = ${gated.rigId} FOR UPDATE`),
      );
      const gatedCreate = createIssue(gatedRow, {
        columnId: gated.columnId,
        title: 'Rig moved',
        labelIds: [],
      });
      await waitForBlocked();
      await db.execute(sql`UPDATE project SET rig_id = ${other.id} WHERE id = ${gated.id}`);
      await rigHeld.release();
      await expect(gatedCreate).rejects.toThrow(/changed its rig/);
      expect(await stored(gated.id, other.id)).toMatchObject({ issues: 0, ledger: 0 });
      // Phase 2: hold the project row with an uncommitted null to rig change, start an ordinary
      // create and let the change commit while it waits on the row.
      const plain = await project(false);
      const late = await one<{ id: number }>(
        sql`INSERT INTO rig (prefix) VALUES (${`c4b2-late-race-${plain.id}`}) RETURNING id`,
      );
      made.rig.push(late.id);
      const plainRow = await getProjectById(plain.id);
      if (!plainRow) throw new Error('project missing');
      const rowHeld = await holdRow((tx) =>
        tx.execute(sql`UPDATE project SET rig_id = ${late.id} WHERE id = ${plain.id}`),
      );
      const plainCreate = createIssue(plainRow, {
        columnId: plain.columnId,
        title: 'Ordinary into gated',
        labelIds: [],
      });
      await waitForBlocked();
      await rowHeld.release();
      await expect(plainCreate).rejects.toThrow(/changed its rig/);
      expect(await stored(plain.id, late.id)).toMatchObject({ issues: 0 });
    } finally {
      await cleanUp();
    }
  }, 60_000);

  it('two creates at once on one gated project take distinct tokens', async () => {
    try {
      const p = await project(true);
      const rows = await Promise.all(
        ['Concurrent A', 'Concurrent B'].map(async (title) => {
          const projectRow = await getProjectById(p.id);
          if (!projectRow) throw new Error('project missing');
          const created = await createIssue(projectRow, {
            columnId: p.columnId,
            title,
            labelIds: [],
          });
          made.issue.push(created.id);
          return created.id;
        }),
      );
      expect(new Set(rows).size).toBe(2);
      const after = await stored(p.id, p.rigId);
      expect([after.issues, after.tokens.length, new Set(after.tokens).size]).toEqual([2, 2, 2]);
    } finally {
      await cleanUp();
    }
  }, 40_000);
});
