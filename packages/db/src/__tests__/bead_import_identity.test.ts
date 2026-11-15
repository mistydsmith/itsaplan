import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { allocateBeadToken, type IdentityTransaction } from '../issue-identity';
import { importBeadIdentity, type ImportIdentityResult } from '../bead-import-identity';
import { sql } from 'drizzle-orm';
import { RUN, targetUrl } from './bead-import-target-guard';

const PREFIX = `imp83631-rig-${RUN}`;
// The exact source ids this suite stamps; the token text is the whole point.
const NUMERIC_ROOT = '9010';
const DAUGHTER = '9010.1';
const HIGHER_ROOT = '9020';
const HASH_TOKEN = 'deadbeef';
const MEMORY_TOKEN = '9010.2';

describe('importBeadIdentity against a real Postgres (prepared; execution held for Root serial slot)', () => {
  // Assigned in beforeAll; if beforeAll dies before the assignment, afterAll
  // guards the undefined value at runtime (the cast there is the only place that
  // case is handled).
  let client: postgres.Sql;
  // The driver type is the actual exported shape of drizzle() (no schema
  // generics: the raw SQL below needs no table typing).
  let db: ReturnType<typeof drizzle>;
  let rigId = 0;
  let projectId = 0;
  const made = {
    issue: [] as number[],
    column: [] as number[],
    project: [] as number[],
    team: [] as number[],
    workspace: [] as number[],
  };
  let rigCountBefore = 0;
  let ledgerCountBefore = 0;

  function inTx(work: (t: IdentityTransaction) => Promise<void>): Promise<void> {
    return db.transaction(async (tx) => {
      await work(tx as unknown as IdentityTransaction);
    });
  }

  // postgres-js returns an ARRAY of row OBJECTS: `const [row]` already hands us the
  // object, so every read in this suite dereferences it as one.
  async function nextRoot(): Promise<number> {
    const [row] = (await client`SELECT next_root FROM rig WHERE id = ${rigId}`) as unknown as {
      next_root: number | string;
    }[];
    return Number(row.next_root);
  }

  async function ledgerRows(token: string) {
    const rows = await client`
      SELECT local_token, root, child, origin, issue_id FROM bead_identity
      WHERE rig_id = ${rigId} AND local_token = ${token}`;
    return rows as unknown as {
      local_token: string;
      root: number | string | null;
      child: number | string | null;
      origin: string;
      issue_id: number | string | null;
    }[];
  }

  async function freshIssue(): Promise<number> {
    const [col] =
      (await client`SELECT id FROM project_column WHERE project_id = ${projectId}`) as unknown as {
        id: number;
      }[];
    // The project's own sequence allocator, exactly the way the real create path takes a
    // number: sequence_number is unique per project, so a hardcoded 1 dies on the second
    // fixture issue in this project.
    const [seq] = (await client`
      UPDATE project SET next_sequence = next_sequence + 1
      WHERE id = ${projectId} RETURNING next_sequence`) as unknown as {
      next_sequence: number;
    }[];
    const [row] = await client`
      INSERT INTO issue (project_id, sequence_number, column_id, title)
      VALUES (${projectId}, ${seq.next_sequence}, ${col.id}, '8363.1 import fixture issue') RETURNING id`;
    made.issue.push(row.id as number);
    return row.id as number;
  }

  beforeAll(async () => {
    const url = targetUrl(process.env.DATABASE_URL, process.env.NODE_ENV);
    client = postgres(url, { max: 1, onnotice: () => undefined });
    db = drizzle(client);
    const [rig] =
      await client`INSERT INTO rig (prefix, next_root) VALUES (${PREFIX}, 1) RETURNING id`;
    rigId = rig.id as number;
    const [ws] =
      await client`INSERT INTO workspace (name) VALUES ('8363.1 import ws') RETURNING id`;
    made.workspace.push(ws.id as number);
    const [team] = await client`
      INSERT INTO team (workspace_id, name, slug)
      VALUES (${ws.id}, '8363.1 import team', ${`imp-${ws.id}`}) RETURNING id`;
    made.team.push(team.id as number);
    const [proj] = await client`
      INSERT INTO project (team_id, key, name)
      VALUES (${team.id}, ${`IMP${ws.id}`}, '8363.1 import project') RETURNING id`;
    projectId = proj.id as number;
    made.project.push(proj.id as number);
    const [col] = await client`
      INSERT INTO project_column (project_id, name, position)
      VALUES (${projectId}, '8363.1 import column', 1) RETURNING id`;
    made.column.push(col.id as number);
    // The retention assertions must not depend on test order: the baseline is
    // taken after this run's rig exists and before any stamp runs. The rig is
    // never deleted in any outcome, so a successful run ends at EXACTLY this
    // baseline: no rig lost, no rig duplicated. (Rig and ledger rows from
    // failed runs persist under their own random prefixes and are inside the
    // baseline, which is why the baseline is per-run.)
    // postgres-js hands us row OBJECTS: r and l are already the rows.
    const [r] = await client`SELECT count(*)::int AS n FROM rig`;
    rigCountBefore = (r as unknown as { n: number }).n;
    const [l] = await client`SELECT count(*)::int AS n FROM bead_identity WHERE rig_id = ${rigId}`;
    ledgerCountBefore = (l as unknown as { n: number }).n;
  });

  afterAll(async () => {
    // beforeAll can die partway: whatever the `made` arrays hold at that point is
    // still torn down here, in foreign-key order, and the client is only touched
    // once it exists (undefined if beforeAll died before the assignment). The rig
    // is NEVER deleted, in ANY outcome (Root 2026-11-15): the owned rig and its
    // ledger are retained immutably - a failed run's rig is preserved and
    // reported, not deleted or guard-disabled, and re-runs add distinct rigs
    // under the random prefix that the count baselines take in.
    const live = client as postgres.Sql | undefined;
    if (!live) return;
    for (const id of made.issue.splice(0)) await live`DELETE FROM issue WHERE id = ${id}`;
    for (const id of made.column.splice(0)) await live`DELETE FROM project_column WHERE id = ${id}`;
    for (const id of made.project.splice(0)) await live`DELETE FROM project WHERE id = ${id}`;
    for (const id of made.team.splice(0)) await live`DELETE FROM team WHERE id = ${id}`;
    for (const id of made.workspace.splice(0)) await live`DELETE FROM workspace WHERE id = ${id}`;
    await live.end();
  });

  it('attaches the exact source id to the issue and the ledger, and moves the counter above it', async () => {
    const issueId = await freshIssue();
    const [before] = (await client`SELECT bead_id FROM issue WHERE id = ${issueId}`) as unknown as {
      bead_id: string | null;
    }[];
    expect(before.bead_id).toBeNull();

    await inTx(async (t) => {
      const res = await importBeadIdentity(t, { rigId, localToken: NUMERIC_ROOT, issueId });
      expect(res).toEqual({ ok: true, beadId: `${PREFIX}-${NUMERIC_ROOT}`, alreadyPresent: false });
    });

    const [stamped] =
      (await client`SELECT bead_id FROM issue WHERE id = ${issueId}`) as unknown as {
        bead_id: string | null;
      }[];
    expect(stamped.bead_id).toBe(`${PREFIX}-${NUMERIC_ROOT}`);
    // The ledger row is the imported shape: exact token, no invented coordinates.
    expect(await ledgerRows(NUMERIC_ROOT)).toEqual([
      {
        local_token: NUMERIC_ROOT,
        root: null,
        child: null,
        origin: 'imported',
        issue_id: issueId,
      },
    ]);
    expect(await nextRoot()).toBeGreaterThanOrEqual(Number(NUMERIC_ROOT) + 1);
  });

  it('a replay of the same attach is idempotent and leaves one ledger row', async () => {
    const [row] =
      (await client`SELECT id FROM issue WHERE bead_id = ${`${PREFIX}-${NUMERIC_ROOT}`}`) as unknown as {
        id: number;
      }[];
    const before = await nextRoot();
    await inTx(async (t) => {
      const res = await importBeadIdentity(t, { rigId, localToken: NUMERIC_ROOT, issueId: row.id });
      expect(res).toEqual({ ok: true, beadId: `${PREFIX}-${NUMERIC_ROOT}`, alreadyPresent: true });
    });
    expect(await ledgerRows(NUMERIC_ROOT)).toHaveLength(1);
    expect(await nextRoot()).toBe(before);
  });

  it('refuses a token collision and rolls back the partial stamp in the same savepoint', async () => {
    const [stamped] =
      (await client`SELECT id FROM issue WHERE bead_id = ${`${PREFIX}-${NUMERIC_ROOT}`}`) as unknown as {
        id: number;
      }[];
    const otherId = await freshIssue();
    let result: ImportIdentityResult;
    await inTx(async (t) => {
      result = await importBeadIdentity(t, { rigId, localToken: NUMERIC_ROOT, issueId: otherId });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected the refusal, not an attach');
      expect(result.code).toBe('conflict');
      // The refusal is a return, not a throw: the caller's transaction stays usable.
      const [probe] = (await t.execute(sql`SELECT 1 AS ok`)) as unknown as {
        ok: number | string;
      }[];
      expect(Number(probe.ok)).toBe(1);
    });
    // No partial stamp survived the savepoint, and the first attach is untouched.
    const [other] = (await client`SELECT bead_id FROM issue WHERE id = ${otherId}`) as unknown as {
      bead_id: string | null;
    }[];
    expect(other.bead_id).toBeNull();
    const [first] =
      (await client`SELECT bead_id FROM issue WHERE id = ${stamped.id}`) as unknown as {
        bead_id: string | null;
      }[];
    expect(first.bead_id).toBe(`${PREFIX}-${NUMERIC_ROOT}`);
    expect(await ledgerRows(NUMERIC_ROOT)).toHaveLength(1);
  });

  it('a daughter and a higher numeric root stamp their exact text and move the counter above both', async () => {
    const daughterIssue = await freshIssue();
    const higherIssue = await freshIssue();
    await inTx(async (t) => {
      expect(
        await importBeadIdentity(t, { rigId, localToken: DAUGHTER, issueId: daughterIssue }),
      ).toEqual({
        ok: true,
        beadId: `${PREFIX}-${DAUGHTER}`,
        alreadyPresent: false,
      });
      expect(
        await importBeadIdentity(t, { rigId, localToken: HIGHER_ROOT, issueId: higherIssue }),
      ).toEqual({
        ok: true,
        beadId: `${PREFIX}-${HIGHER_ROOT}`,
        alreadyPresent: false,
      });
    });
    for (const token of [DAUGHTER, HIGHER_ROOT]) {
      const rows = await ledgerRows(token);
      expect(rows.map((r) => r.local_token)).toEqual([token]);
      expect(rows[0].origin).toBe('imported');
      expect(rows[0].root).toBeNull();
      expect(rows[0].child).toBeNull();
    }
    // The counter sits above the highest imported NUMERIC root, and the daughter
    // did not open a new one.
    expect(await nextRoot()).toBeGreaterThanOrEqual(Number(HIGHER_ROOT) + 1);
  });

  it('a hash token stamps its exact text without touching the counter', async () => {
    const issueId = await freshIssue();
    const before = await nextRoot();
    await inTx(async (t) => {
      expect(await importBeadIdentity(t, { rigId, localToken: HASH_TOKEN, issueId })).toEqual({
        ok: true,
        beadId: `${PREFIX}-${HASH_TOKEN}`,
        alreadyPresent: false,
      });
    });
    expect(await ledgerRows(HASH_TOKEN)).toEqual([
      {
        local_token: HASH_TOKEN,
        root: null,
        child: null,
        origin: 'imported',
        issue_id: issueId,
      },
    ]);
    expect(await nextRoot()).toBe(before);
  });

  it('the real minted owner then mints a root above everything the import brought in', async () => {
    let minted: number | null = null;
    await inTx(async (t) => {
      const res = await allocateBeadToken(t, { rigId, projectId, parentId: null, mode: 'root' });
      expect(res.ok).toBe(true);
      if (res.ok) minted = Number(res.allocation.root);
    });
    expect(minted).toBeGreaterThanOrEqual(Number(HIGHER_ROOT) + 1);
  });

  it('stamps a tombstone for a retained non-ticket row: exact token, no issue, replay idempotent', async () => {
    await inTx(async (t) => {
      expect(
        await importBeadIdentity(t, { rigId, localToken: MEMORY_TOKEN, issueId: null }),
      ).toEqual({
        ok: true,
        beadId: `${PREFIX}-${MEMORY_TOKEN}`,
        alreadyPresent: false,
      });
    });
    // The tombstone keeps the retained row's exact id and points at no issue: the
    // card's content lives in the retained artifact, the identity lives here.
    expect(await ledgerRows(MEMORY_TOKEN)).toEqual([
      {
        local_token: MEMORY_TOKEN,
        root: null,
        child: null,
        origin: 'imported',
        issue_id: null,
      },
    ]);
    await inTx(async (t) => {
      expect(
        await importBeadIdentity(t, { rigId, localToken: MEMORY_TOKEN, issueId: null }),
      ).toEqual({
        ok: true,
        beadId: `${PREFIX}-${MEMORY_TOKEN}`,
        alreadyPresent: true,
      });
    });
    expect(await ledgerRows(MEMORY_TOKEN)).toHaveLength(1);
  });

  it('an aborted caller transaction rolls back the stamp, the ledger row and the counter', async () => {
    const issueId = await freshIssue();
    const before = await nextRoot();
    const rollback = Symbol('rollback');
    try {
      await db.transaction(async (tx) => {
        const t = tx as unknown as IdentityTransaction;
        const res = await importBeadIdentity(t, { rigId, localToken: '9030', issueId });
        expect(res.ok).toBe(true);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    const [stamp] = (await client`SELECT bead_id FROM issue WHERE id = ${issueId}`) as unknown as {
      bead_id: string | null;
    }[];
    expect(stamp.bead_id).toBeNull();
    expect(await ledgerRows('9030')).toHaveLength(0);
    expect(await nextRoot()).toBe(before);
  });

  it('leaves exactly the rig and the five imported ledger rows, asserted by count and token', async () => {
    // The minted owner adds no ledger row: allocateBeadToken is a pure allocator
    // (its ledger row is inserted by the caller only once the issue exists), and
    // the aborted-transaction token '9030' rolled back with its stamp. So the
    // rig's ledger holds exactly the five imported tokens, and no other - if the
    // allocator contract ever changes, this assertion catches it.
    const rows = (await client`
      SELECT local_token FROM bead_identity WHERE rig_id = ${rigId} ORDER BY local_token`) as unknown as {
      local_token: string;
    }[];
    expect(rows.map((x) => x.local_token)).toEqual([
      NUMERIC_ROOT,
      DAUGHTER,
      MEMORY_TOKEN,
      HIGHER_ROOT,
      HASH_TOKEN,
    ]);
    const [r] = await client`SELECT count(*)::int AS n FROM rig`;
    expect((r as unknown as { n: number }).n).toBe(rigCountBefore);
    const [l] = await client`SELECT count(*)::int AS n FROM bead_identity WHERE rig_id = ${rigId}`;
    expect((l as unknown as { n: number }).n).toBe(ledgerCountBefore + 5);
  });
});
