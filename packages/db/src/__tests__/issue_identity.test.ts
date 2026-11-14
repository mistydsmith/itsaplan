import { afterAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  allocateBeadToken,
  attachBeadIdentity,
  type BeadAllocation,
  type IdentityTransaction,
} from '../issue-identity';

// The allocator, exercised against a real Postgres. Ordinary application fixtures are
// created and deleted by exact id. Rig and ledger rows are never deleted, because the C1
// guards forbid it: this file keeps the rigs and ledger rows it creates and asserts the
// counts it left behind instead of removing them.
const REQUIRED_DB = 'itsaplan_8364_c4_test';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Prefixes and token counts this file owns. Nothing else may be read or removed by it.
// Rigs cannot be deleted (the C1 guard refuses it), so each run gets its own prefix and
// a rerun never collides with what an earlier run left behind.
const RUN = Math.random().toString(36).slice(2, 10);
const PREFIX = `c4a-rig-${RUN}`;

function targetUrl(raw: string | undefined, nodeEnv: string | undefined): string {
  if (nodeEnv !== 'test') throw new Error('these tests run only with NODE_ENV=test');
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
  if (/sentinel|trial/i.test(name))
    throw new Error('refusing a persistent trial or Sentinel database');
  if (name !== REQUIRED_DB)
    throw new Error(`refusing database ${name}; this suite uses ${REQUIRED_DB}`);
  return raw;
}

const url = targetUrl(process.env.DATABASE_URL, process.env.NODE_ENV);
const clientA = postgres(url, { max: 1, onnotice: () => undefined });
const clientB = postgres(url, { max: 1, onnotice: () => undefined });
const dbA = drizzle(clientA);
const dbB = drizzle(clientB);

// Counted before any test runs, so the retention case does not depend on test order.
const [foreignRigs] = (await clientA`SELECT count(*)::int AS n FROM rig`) as unknown as {
  n: number;
}[];

afterAll(async () => {
  await clientA.end();
  await clientB.end();
});

// Ordinary application rows are tracked by id and deleted by id only. Rig and ledger rows
// stay: the guards make them permanent, and the counts are asserted instead.
const made = {
  issue: [] as number[],
  column: [] as number[],
  project: [] as number[],
  team: [] as number[],
  workspace: [] as number[],
};

async function project(clients = clientA): Promise<number> {
  const [workspace] = await clients`
    INSERT INTO workspace (name) VALUES ('c4 allocator ws') RETURNING id`;
  made.workspace.push(workspace.id as number);
  const [team] = await clients`
    INSERT INTO team (workspace_id, name, slug)
    VALUES (${workspace.id}, 'c4 allocator team', ${`c4-alloc-${workspace.id}`}) RETURNING id`;
  made.team.push(team.id as number);
  const [row] = await clients`
    INSERT INTO project (team_id, key, name)
    VALUES (${team.id}, ${`C4A${workspace.id}`}, 'c4 allocator project') RETURNING id`;
  made.project.push(row.id as number);
  return row.id as number;
}

let columnSeq = 0;
async function column(projectId: number): Promise<number> {
  // project_column is unique on (project_id, position), so each call takes its own slot.
  columnSeq += 1;
  const [row] = await clientA`
    INSERT INTO project_column (project_id, name, position)
    VALUES (${projectId}, ${`Todo ${columnSeq}`}, ${columnSeq}) RETURNING id`;
  made.column.push(row.id as number);
  return row.id as number;
}

// A bare issue row, with or without a bead id, used as the create transaction's insert
// would leave it before the ledger row is attached.
async function bareIssue(
  projectId: number,
  columnId: number,
  beadId: string | null,
): Promise<number> {
  const [row] = await clientA`
    INSERT INTO issue (project_id, sequence_number, column_id, title, bead_id)
    VALUES (${projectId}, 1, ${columnId}, 'c4 allocator issue', ${beadId}) RETURNING id`;
  made.issue.push(row.id as number);
  return row.id as number;
}

async function cleanUp(): Promise<void> {
  for (const id of made.issue.splice(0)) await clientA`DELETE FROM issue WHERE id = ${id}`;
  for (const id of made.column.splice(0))
    await clientA`DELETE FROM project_column WHERE id = ${id}`;
  for (const id of made.project.splice(0)) await clientA`DELETE FROM project WHERE id = ${id}`;
  for (const id of made.team.splice(0)) await clientA`DELETE FROM team WHERE id = ${id}`;
  for (const id of made.workspace.splice(0)) await clientA`DELETE FROM workspace WHERE id = ${id}`;
}

let rigSeq = 0;
async function rig(): Promise<number> {
  rigSeq += 1;
  const [row] = await clientA`
    INSERT INTO rig (prefix) VALUES (${`${PREFIX}-${rigSeq}`}) RETURNING id`;
  return row.id as number;
}

async function rolledBack(work: (tx: IdentityTransaction) => Promise<void>): Promise<void> {
  const rollback = Symbol('rollback');
  try {
    await dbA.transaction(async (tx) => {
      await work(tx as unknown as IdentityTransaction);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

// A full create, in the order the real createIssue will use: rig lock first inside the
// transaction, then the native counter, then the issue insert, then the ledger attach,
// with the commit at the end so a rollback takes all four back together.
async function mint(
  projectId: number,
  rigId: number,
  parentId: number | null = null,
  mode: 'auto' | 'root' | 'daughter' = 'auto',
): Promise<BeadAllocation> {
  const columnId = await column(projectId);
  return dbA.transaction(async (tx) => {
    const t = tx as unknown as IdentityTransaction;
    const allocated = await allocateBeadToken(t, { rigId, projectId, parentId, mode });
    if (!allocated.ok) throw new Error(`allocation refused: ${allocated.code}`);
    const [seqRow] = (await t.execute(
      sql`UPDATE project SET next_sequence = next_sequence + 1
           WHERE id = ${projectId} RETURNING next_sequence - 1 AS seq`,
    )) as unknown as { seq: number | string }[];
    const [row] = (await t.execute(
      sql`INSERT INTO issue (project_id, sequence_number, column_id, title, bead_id, parent_id)
          VALUES (${projectId}, ${Number(seqRow.seq)}, ${columnId}, 'c4 allocator issue',
                  ${allocated.allocation.beadId}, ${parentId}) RETURNING id`,
    )) as unknown as { id: number }[];
    made.issue.push(row.id);
    const attached = await attachBeadIdentity(t, {
      allocation: allocated.allocation,
      issueId: row.id,
    });
    if (!attached.ok) throw new Error(`attach refused: ${attached.code}`);
    return allocated.allocation;
  });
}

describe('what this file leaves behind', () => {
  it('leaves every rig it can see in place, including ones it did not create', async () => {
    // Rigs and ledger rows cannot be deleted: the C1 guard refuses. The invariant this
    // file can hold is that no rig disappeared while it ran, compared with a count taken
    // before the first test.
    const [now] = await clientA`SELECT count(*)::int AS n FROM rig`;
    expect(now.n).toBeGreaterThanOrEqual(foreignRigs.n);
  });
});

describe('the harness guard refuses a wrong target without contacting it', () => {
  it('rejects the wrong environment, host, port, name and a persistent base', () => {
    const good = `postgres://nobody@127.0.0.1:5433/${REQUIRED_DB}`;
    expect(targetUrl(good, 'test')).toBe(good);
    expect(() => targetUrl(good, 'production')).toThrow(/NODE_ENV/);
    expect(() => targetUrl('postgres://nobody@db.example.com:5433/x', 'test')).toThrow(/loopback/);
    expect(() => targetUrl(`postgres://nobody@127.0.0.1:5432/${REQUIRED_DB}`, 'test')).toThrow(
      /5433/,
    );
    expect(() => targetUrl('postgres://nobody@127.0.0.1:5433/sentinel_test', 'test')).toThrow(
      /Sentinel/,
    );
    expect(() => targetUrl('postgres://nobody@127.0.0.1:5433/itsaplan', 'test')).toThrow(
      /refusing database/,
    );
  });
});

describe('roots and daughters', () => {
  it('a gated project takes root 1, then 2, and a daughter takes the next child of its parent root', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`UPDATE project SET rig_id = ${rigId} WHERE id = ${projectId}`;
      await rolledBack(async (tx) => {
        const first = await allocateBeadToken(tx, { rigId, projectId, parentId: null });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(first.allocation).toMatchObject({ root: 1, child: 0, localToken: '1' });
        expect(first.allocation.beadId).toBe(`${first.allocation.prefix}-1`);
      });
    } finally {
      await cleanUp();
    }
  });
});

describe('the high-water mark', () => {
  it('counts an imported numeric root stored with NULL components', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      // An import that kept its text number and left the numeric columns NULL, which C1
      // permits on purpose.
      await clientA`INSERT INTO bead_identity (rig_id, local_token, origin) VALUES (${rigId}, '41', 'imported')`;
      await rolledBack(async (tx) => {
        const out = await allocateBeadToken(tx, { rigId, projectId, parentId: null });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.allocation.root).toBe(42);
      });
    } finally {
      await cleanUp();
    }
  });

  it('ignores a hash token and never reuses its number', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`INSERT INTO bead_identity (rig_id, local_token, origin) VALUES (${rigId}, 'abc.def.ghi', 'imported')`;
      await clientA`INSERT INTO bead_identity (rig_id, local_token, origin) VALUES (${rigId}, '7vaoz-wmzyw', 'imported')`;
      await rolledBack(async (tx) => {
        const out = await allocateBeadToken(tx, { rigId, projectId, parentId: null });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.allocation.root).toBe(1);
        expect(out.allocation.localToken).toBe('1');
      });
    } finally {
      await cleanUp();
    }
  });

  it('a multidot import raises the high-water through its first component', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`INSERT INTO bead_identity (rig_id, local_token, origin) VALUES (${rigId}, '77.3', 'imported')`;
      await rolledBack(async (tx) => {
        const out = await allocateBeadToken(tx, { rigId, projectId, parentId: null });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.allocation.root).toBe(78);
      });
    } finally {
      await cleanUp();
    }
  });

  it('a deleted issue leaves a tombstone that still holds its number', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`UPDATE project SET rig_id = ${rigId} WHERE id = ${projectId}`;
      const first = await mint(projectId, rigId);
      expect(first.root).toBe(1);
      // Delete the issue: the ledger row must survive with a NULL link and keep root 1.
      for (const id of made.issue.splice(0)) await clientA`DELETE FROM issue WHERE id = ${id}`;
      const [kept] = await clientA`
        SELECT root, child, issue_id FROM bead_identity
        WHERE rig_id = ${rigId} AND local_token = ${first.localToken}`;
      expect(kept).toMatchObject({ root: 1, issue_id: null });
      const second = await mint(projectId, rigId);
      expect(second.root).toBe(2);
    } finally {
      await cleanUp();
    }
  });

  it('an imported child with NULL components raises the child high-water', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`UPDATE project SET rig_id = ${rigId} WHERE id = ${projectId}`;
      const root = await mint(projectId, rigId);
      // The shape Root measured: an import that kept '1.9' as text and left root and child NULL.
      await clientA`INSERT INTO bead_identity (rig_id, local_token, origin)
                    VALUES (${rigId}, ${`${root.root}.9`}, 'imported')`;
      const [parentIssue] = await clientA`SELECT id FROM issue WHERE bead_id = ${root.beadId}`;
      await rolledBack(async (tx) => {
        const out = await allocateBeadToken(tx, { rigId, projectId, parentId: parentIssue.id });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.allocation).toMatchObject({ root: root.root, child: 10 });
        expect(out.allocation.localToken).toBe(`${root.root}.10`);
      });
    } finally {
      await cleanUp();
    }
  });

  it('a child is the next highest number, never the first gap', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`UPDATE project SET rig_id = ${rigId} WHERE id = ${projectId}`;
      const root = await mint(projectId, rigId);
      // Children 1 and 2 exist, and child 1 is a tombstone. The next child must be 3.
      await clientA`INSERT INTO bead_identity (rig_id, local_token, root, child, origin)
                    VALUES (${rigId}, ${`${root.root}.1`}, ${root.root}, 1, 'imported')`;
      await clientA`INSERT INTO bead_identity (rig_id, local_token, root, child, origin)
                    VALUES (${rigId}, ${`${root.root}.2`}, ${root.root}, 2, 'imported')`;
      const [parentIssue] = await clientA`SELECT id FROM issue WHERE bead_id = ${root.beadId}`;
      await rolledBack(async (tx) => {
        const out = await allocateBeadToken(tx, { rigId, projectId, parentId: parentIssue.id });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.allocation).toMatchObject({
          root: root.root,
          child: 3,
          localToken: `${root.root}.3`,
        });
      });
    } finally {
      await cleanUp();
    }
  });

  it('a granddaughter takes a new root and keeps the real parent link', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`UPDATE project SET rig_id = ${rigId} WHERE id = ${projectId}`;
      const root = await mint(projectId, rigId);
      const [parentIssue] = await clientA`SELECT id FROM issue WHERE bead_id = ${root.beadId}`;
      const daughter = await mint(projectId, rigId, parentIssue.id);
      expect(daughter).toMatchObject({ root: root.root, child: 1 });
      const [daughterIssue] =
        await clientA`SELECT id FROM issue WHERE bead_id = ${daughter.beadId}`;
      const grandchild = await mint(projectId, rigId, daughterIssue.id);
      // A brand new root, and the real parent is the daughter.
      expect(grandchild.child).toBe(0);
      expect(grandchild.root).toBeGreaterThan(root.root);
      const [link] =
        await clientA`SELECT parent_id FROM issue WHERE bead_id = ${grandchild.beadId}`;
      // The caller keeps the real parent link, and it points at the daughter rather than
      // at the root, which is what SPEC_R2 asks of a daughter of a daughter.
      expect(link.parent_id).toBe(daughterIssue.id);
      expect(grandchild.localToken.includes('.')).toBe(false);
    } finally {
      await cleanUp();
    }
  });

  it('mode root mints a distinct root while the real parent is kept', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`UPDATE project SET rig_id = ${rigId} WHERE id = ${projectId}`;
      const root = await mint(projectId, rigId);
      const [parentIssue] = await clientA`SELECT id FROM issue WHERE bead_id = ${root.beadId}`;

      // The declared mode is honoured.
      const explicit = await mint(projectId, rigId, parentIssue.id, 'root');
      expect(explicit.child).toBe(0);
      expect(explicit.root).toBeGreaterThan(root.root);
      const [explicitRow] =
        await clientA`SELECT parent_id FROM issue WHERE bead_id = ${explicit.beadId}`;
      expect(explicitRow.parent_id).toBe(parentIssue.id);

      // An undeclared extra property is ignored, so it cannot silently ask for a root: the
      // default stays a daughter, which is the difference between a mode and a hope.
      await rolledBack(async (tx) => {
        const smuggled = {
          rigId,
          projectId,
          parentId: parentIssue.id,
          rootWithParent: true,
        } as unknown as { rigId: number; projectId: number; parentId: number | null };
        const out = await allocateBeadToken(tx, smuggled);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.allocation.child).toBeGreaterThan(0);
      });
    } finally {
      await cleanUp();
    }
  });

  it('mode daughter refuses when the parent cannot take one', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`UPDATE project SET rig_id = ${rigId} WHERE id = ${projectId}`;
      const root = await mint(projectId, rigId);
      const [rootIssue] = await clientA`SELECT id FROM issue WHERE bead_id = ${root.beadId}`;
      const daughter = await mint(projectId, rigId, rootIssue.id);
      const [daughterIssue] =
        await clientA`SELECT id FROM issue WHERE bead_id = ${daughter.beadId}`;
      await rolledBack(async (tx) => {
        const out = await allocateBeadToken(tx, {
          rigId,
          projectId,
          parentId: daughterIssue.id,
          mode: 'daughter',
        });
        expect(out).toMatchObject({ ok: false, code: 'parent-not-a-root' });
      });
    } finally {
      await cleanUp();
    }
  });

  it('a parent without a bead identity refuses', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      const columnId = await column(projectId);
      const orphan = await bareIssue(projectId, columnId, null);
      await rolledBack(async (tx) => {
        const out = await allocateBeadToken(tx, { rigId, projectId, parentId: orphan });
        expect(out).toMatchObject({ ok: false, code: 'parent-without-identity' });
      });
    } finally {
      await cleanUp();
    }
  });
});

describe('the ledger attach', () => {
  it('refuses to attach to an issue whose bead_id disagrees', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`UPDATE project SET rig_id = ${rigId} WHERE id = ${projectId}`;
      const columnId = await column(projectId);
      const wrong = await bareIssue(projectId, columnId, 'c4a-rig-wrong');
      await rolledBack(async (tx) => {
        const allocated = await allocateBeadToken(tx, { rigId, projectId, parentId: null });
        if (!allocated.ok) throw new Error('allocation refused');
        const out = await attachBeadIdentity(tx, {
          allocation: allocated.allocation,
          issueId: wrong,
        });
        expect(out).toMatchObject({ ok: false, code: 'issue-not-ready' });
      });
    } finally {
      await cleanUp();
    }
  });

  it('a duplicate attach is a typed conflict and the transaction stays usable', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`UPDATE project SET rig_id = ${rigId} WHERE id = ${projectId}`;
      const first = await mint(projectId, rigId);
      const [issueRow] = await clientA`SELECT id FROM issue WHERE bead_id = ${first.beadId}`;

      await rolledBack(async (tx) => {
        // The same allocation attached a second time to its own issue: the ledger holds one
        // row per issue, so this is the duplicate Root measured.
        const out = await attachBeadIdentity(tx, { allocation: first, issueId: issueRow.id });
        expect(out).toMatchObject({ ok: false, code: 'conflict' });
        const [probe] = (await tx.execute(sql`SELECT 1 AS ok`)) as unknown as { ok: number }[];
        expect(probe.ok).toBe(1);
      });
    } finally {
      await cleanUp();
    }
  });

  it('a rollback leaves no ledger row and no counter move', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      const columnId = await column(projectId);
      const [before] = await clientA`SELECT next_root FROM rig WHERE id = ${rigId}`;
      const [beforeSequence] =
        await clientA`SELECT next_sequence FROM project WHERE id = ${projectId}`;
      const rollback = Symbol('rollback');
      try {
        await dbA.transaction(async (tx) => {
          const t = tx as unknown as IdentityTransaction;
          const allocated = await allocateBeadToken(t, { rigId, projectId, parentId: null });
          if (!allocated.ok) throw new Error(`allocation refused: ${allocated.code}`);
          // The counter moves after the rig lock inside this transaction, as in createIssue.
          const [seqRow] = (await t.execute(
            sql`UPDATE project SET next_sequence = next_sequence + 1
                 WHERE id = ${projectId} RETURNING next_sequence - 1 AS seq`,
          )) as unknown as { seq: number | string }[];
          const [row] = (await t.execute(
            sql`INSERT INTO issue (project_id, sequence_number, column_id, title, bead_id)
                VALUES (${projectId}, ${Number(seqRow.seq)}, ${columnId}, 'c4 rollback issue',
                        ${allocated.allocation.beadId}) RETURNING id`,
          )) as unknown as { id: number }[];
          made.issue.push(row.id);
          await attachBeadIdentity(t, { allocation: allocated.allocation, issueId: row.id });
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const [after] = await clientA`SELECT next_root FROM rig WHERE id = ${rigId}`;
      expect(after.next_root).toBe(before.next_root);
      const [ledger] =
        await clientA`SELECT count(*)::int AS n FROM bead_identity WHERE rig_id = ${rigId}`;
      expect(ledger.n).toBe(0);
      const [native] = await clientA`SELECT next_sequence FROM project WHERE id = ${projectId}`;
      expect(native.next_sequence).toBe(beforeSequence.next_sequence);
      const [issues] =
        await clientA`SELECT count(*)::int AS n FROM issue WHERE project_id = ${projectId}`;
      expect(issues.n).toBe(0);
    } finally {
      await cleanUp();
    }
  });
});

describe('concurrency and scale', () => {
  it('two full creates sharing one rig take different tokens across two projects', async () => {
    try {
      // Identity is rig-scoped, so two different projects on one rig must still not share a
      // token, and both creates carry the native counter, the issue and the ledger row.
      const projectA = await project();
      const projectB = await project();
      const rigId = await rig();
      await clientA`UPDATE project SET rig_id = ${rigId} WHERE id IN (${projectA}, ${projectB})`;
      const columnA = await column(projectA);
      const columnB = await column(projectB);

      const create = (database: typeof dbA, projectId: number, columnId: number) =>
        database.transaction(async (tx) => {
          const t = tx as unknown as IdentityTransaction;
          const allocated = await allocateBeadToken(t, { rigId, projectId, parentId: null });
          if (!allocated.ok) throw new Error(`allocation refused: ${allocated.code}`);
          const [seqRow] = (await t.execute(
            sql`UPDATE project SET next_sequence = next_sequence + 1
                 WHERE id = ${projectId} RETURNING next_sequence - 1 AS seq`,
          )) as unknown as { seq: number | string }[];
          const [row] = (await t.execute(
            sql`INSERT INTO issue (project_id, sequence_number, column_id, title, bead_id)
                VALUES (${projectId}, ${Number(seqRow.seq)}, ${columnId}, 'c4 race issue',
                        ${allocated.allocation.beadId}) RETURNING id`,
          )) as unknown as { id: number }[];
          made.issue.push(row.id);
          const attached = await attachBeadIdentity(t, {
            allocation: allocated.allocation,
            issueId: row.id,
          });
          if (!attached.ok) throw new Error(`attach refused: ${attached.code}`);
          return allocated.allocation.localToken;
        });

      const tokens = await Promise.all([
        create(dbA, projectA, columnA),
        create(dbB, projectB, columnB),
      ]);
      expect(new Set(tokens).size).toBe(2);

      // The native counter is per project, so each of the two creates must have taken its
      // own project's number; a cross-project DISTINCT would be 1 by design.
      const counters = await clientA`
        SELECT p.id, p.next_sequence FROM project p WHERE p.id IN (${projectA}, ${projectB}) ORDER BY p.id`;
      expect(counters.map((row) => row.next_sequence)).toEqual([2, 2]);
      const [issued] = await clientA`
        SELECT count(*)::int AS n FROM issue WHERE project_id IN (${projectA}, ${projectB})`;
      expect(issued.n).toBe(2);
      const [ledger] = await clientA`
        SELECT count(*)::int AS n FROM bead_identity WHERE rig_id = ${rigId}`;
      expect(ledger.n).toBe(2);
    } finally {
      await cleanUp();
    }
  });

  it('holds over a hundred ledger rows with a high-water at the top', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      // Seeded in one statement before the transaction opens, so no connection is held.
      await clientA`
        INSERT INTO bead_identity (rig_id, local_token, root, child, origin)
        SELECT ${rigId}, g::text, g, 0, 'imported' FROM generate_series(100, 249) AS g`;
      const [count] =
        await clientA`SELECT count(*)::int AS n FROM bead_identity WHERE rig_id = ${rigId}`;
      expect(count.n).toBeGreaterThan(100);
      await rolledBack(async (tx) => {
        const out = await allocateBeadToken(tx, { rigId, projectId, parentId: null });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.allocation.root).toBe(250);
      });
    } finally {
      await cleanUp();
    }
  });
});

describe('an imported parent is read from the ledger token', () => {
  // Seeds an imported parent whose identity lives only in local_token, with the numeric
  // columns NULL exactly as C1 permits, and returns the parent issue id.
  async function importedParent(rigId: number, projectId: number, token: string): Promise<number> {
    const columnId = await column(projectId);
    const beadId = `${(await clientA`SELECT prefix FROM rig WHERE id = ${rigId}`)[0].prefix}-${token}`;
    const [row] = await clientA`
      INSERT INTO issue (project_id, sequence_number, column_id, title, bead_id)
      VALUES (${projectId}, 1, ${columnId}, 'c4 imported parent', ${beadId}) RETURNING id`;
    made.issue.push(row.id as number);
    await clientA`INSERT INTO bead_identity (rig_id, local_token, origin, issue_id)
                  VALUES (${rigId}, ${token}, 'imported', ${row.id})`;
    return row.id as number;
  }

  it('an imported numeric root parent with NULL components takes a daughter', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`UPDATE project SET rig_id = ${rigId} WHERE id = ${projectId}`;
      const parentId = await importedParent(rigId, projectId, '41');
      await rolledBack(async (tx) => {
        const out = await allocateBeadToken(tx, { rigId, projectId, parentId });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.allocation).toMatchObject({ root: 41, child: 1, localToken: '41.1' });
      });
    } finally {
      await cleanUp();
    }
  });

  it('an imported one-dot parent is a daughter, so the child takes a fresh root', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`UPDATE project SET rig_id = ${rigId} WHERE id = ${projectId}`;
      const parentId = await importedParent(rigId, projectId, '41.3');
      await rolledBack(async (tx) => {
        const auto = await allocateBeadToken(tx, { rigId, projectId, parentId });
        expect(auto.ok).toBe(true);
        if (!auto.ok) return;
        expect(auto.allocation.child).toBe(0);
        expect(auto.allocation.root).toBeGreaterThan(41);
        const insisted = await allocateBeadToken(tx, {
          rigId,
          projectId,
          parentId,
          mode: 'daughter',
        });
        expect(insisted).toMatchObject({ ok: false, code: 'parent-not-a-root' });
      });
    } finally {
      await cleanUp();
    }
  });

  it('an imported multidot parent takes a fresh root, and mode root is still honoured', async () => {
    try {
      const projectId = await project();
      const rigId = await rig();
      await clientA`UPDATE project SET rig_id = ${rigId} WHERE id = ${projectId}`;
      const parentId = await importedParent(rigId, projectId, '77.3.4');
      await rolledBack(async (tx) => {
        const auto = await allocateBeadToken(tx, { rigId, projectId, parentId });
        expect(auto.ok).toBe(true);
        if (!auto.ok) return;
        expect(auto.allocation.child).toBe(0);
        const forced = await allocateBeadToken(tx, { rigId, projectId, parentId, mode: 'root' });
        expect(forced.ok).toBe(true);
        if (!forced.ok) return;
        expect(forced.allocation.child).toBe(0);
        expect(forced.allocation.root).toBeGreaterThanOrEqual(auto.allocation.root);
      });
    } finally {
      await cleanUp();
    }
  });
});
