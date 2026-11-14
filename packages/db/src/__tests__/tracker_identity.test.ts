import { afterAll, describe, expect, it } from 'bun:test';
import postgres, { type TransactionSql } from 'postgres';

// The schema this suite exercises, added by C1. No test allocates a bead id and none
// touches a real board; every row is built here and rolled back.
const REQUIRED_DB = 'itsaplan_8364_c1_test_r2';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Pure guard: runs before a client exists, so a wrong target is never contacted. It
// refuses a shared test database and the persistent trial or Sentinel names outright.
function targetUrl(raw: string | undefined, nodeEnv: string | undefined): URL {
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
  // The persistent names are refused before the exact-name check, so the message names
  // the real hazard rather than a generic mismatch.
  if (/sentinel|trial/i.test(name)) {
    throw new Error('refusing a persistent trial or Sentinel database');
  }
  if (name !== REQUIRED_DB) {
    throw new Error(`refusing database ${name}; this suite uses ${REQUIRED_DB}`);
  }
  return url;
}

const sql = postgres(targetUrl(process.env.DATABASE_URL, process.env.NODE_ENV).toString(), {
  max: 1,
  onnotice: () => undefined,
});

afterAll(async () => {
  await sql.end();
});

// One transaction per test, always rolled back, so nothing is committed and no shared
// database loses rows. There is no BEGIN in a hook and no TRUNCATE anywhere.
const ROLLBACK = Symbol('rollback');
async function rolledBack(fn: (tx: TransactionSql) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

// A savepoint around exactly one intended refusal. The error leaves the savepoint so
// postgres rolls it back, which is what keeps the outer transaction usable; the next
// statement proves that, so a 25P02 abort can never be mistaken for a passing refusal.
async function expectRefusal(
  tx: TransactionSql,
  code: string,
  run: (sp: TransactionSql) => Promise<unknown>,
): Promise<void> {
  let caught: { code?: string } | null = null;
  try {
    await tx.savepoint(async (sp) => {
      await run(sp);
    });
  } catch (error) {
    caught = error as { code?: string };
  }
  expect(caught?.code).toBe(code);
  const [probe] = await tx`select 1 as ok`;
  expect(probe.ok).toBe(1);
}

function fixtures(tx: TransactionSql, tag: string) {
  const prefix = `c1-${tag}`;
  let seq = 0;
  return {
    async workspace(): Promise<number> {
      const [row] = await tx`INSERT INTO workspace (name) VALUES (${`c1 ${tag}`}) RETURNING id`;
      return row.id as number;
    },
    async team(workspaceId: number): Promise<number> {
      seq += 1;
      const [row] = await tx`
        INSERT INTO team (workspace_id, name, slug)
        VALUES (${workspaceId}, ${`c1 ${tag} team ${seq}`}, ${`${prefix}-team-${seq}`}) RETURNING id`;
      return row.id as number;
    },
    async rig(): Promise<number> {
      seq += 1;
      const [row] = await tx`INSERT INTO rig (prefix) VALUES (${`${prefix}-${seq}`}) RETURNING id`;
      return row.id as number;
    },
    async project(rigId: number | null): Promise<{ id: number; nextSequence: number }> {
      seq += 1;
      const workspaceId = await this.workspace();
      const teamId = await this.team(workspaceId);
      const [row] = await tx`
        INSERT INTO project (team_id, key, name, rig_id)
        VALUES (${teamId}, ${`C1${seq}`}, ${`c1 ${tag} project ${seq}`}, ${rigId})
        RETURNING id, next_sequence`;
      return { id: row.id as number, nextSequence: row.next_sequence as number };
    },
    async issue(projectId: number, sequenceNumber = 1): Promise<number> {
      // Each issue gets its own column because project_column is unique on
      // (project_id, position): reusing position 0 raised 23505 in the first run.
      seq += 1;
      const [column] = await tx`
        INSERT INTO project_column (project_id, name, position)
        VALUES (${projectId}, ${`Todo ${seq}`}, ${seq}) RETURNING id`;
      const [row] = await tx`
        INSERT INTO issue (project_id, sequence_number, column_id, title)
        VALUES (${projectId}, ${sequenceNumber}, ${column.id}, 'c1 issue') RETURNING id`;
      return row.id as number;
    },
  };
}

describe('the harness guard refuses a wrong target without contacting it', () => {
  it('rejects a non-loopback host and a wrong port and name', () => {
    const good = `postgres://nobody@127.0.0.1:5433/${REQUIRED_DB}`;
    expect(targetUrl(good, 'test').pathname).toBe(`/${REQUIRED_DB}`);
    expect(() => targetUrl(good, 'production')).toThrow(/NODE_ENV/);
    expect(() => targetUrl('postgres://nobody@db.example.com:5433/x', 'test')).toThrow(/loopback/);
    expect(() => targetUrl(`postgres://nobody@127.0.0.1:5432/${REQUIRED_DB}`, 'test')).toThrow(
      /5433/,
    );
    expect(() => targetUrl('postgres://nobody@127.0.0.1:5433/itsaplan', 'test')).toThrow(
      /refusing database/,
    );
    expect(() => targetUrl('postgres://nobody@127.0.0.1:5433/sentinel_prod_test', 'test')).toThrow(
      /Sentinel/,
    );
  });
});

describe('schema shape', () => {
  it('an ordinary project keeps a null rig and its native counter', async () => {
    await rolledBack(async (tx) => {
      const f = fixtures(tx, 'plain');
      const project = await f.project(null);
      expect(project.nextSequence).toBe(1);
      const issueId = await f.issue(project.id);
      expect(issueId).toBeGreaterThan(0);
      const [after] = await tx`SELECT next_sequence FROM project WHERE id = ${project.id}`;
      expect(after.next_sequence).toBe(project.nextSequence);
    });
  });

  it('a prefix rejects whitespace and empty, and accepts a plain one', async () => {
    await rolledBack(async (tx) => {
      await expectRefusal(tx, '23514', (sp) => sp`INSERT INTO rig (prefix) VALUES ('bad rig')`);
      await expectRefusal(tx, '23514', (sp) => sp`INSERT INTO rig (prefix) VALUES ('')`);
      const [row] = await tx`INSERT INTO rig (prefix) VALUES ('c1-plain-ok') RETURNING id`;
      expect(row.id).toBeGreaterThan(0);
    });
  });
});

describe('minted and imported tokens', () => {
  it('a minted token must be what its coordinates spell', async () => {
    await rolledBack(async (tx) => {
      const f = fixtures(tx, 'minted');
      const rigId = await f.rig();
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`
        INSERT INTO bead_identity (rig_id, local_token, root, child, origin)
        VALUES (${rigId}, 'abc', 1, 0, 'minted')`,
      );
      const [root] = await tx`
        INSERT INTO bead_identity (rig_id, local_token, root, child, origin)
        VALUES (${rigId}, '8425', 8425, 0, 'minted') RETURNING id`;
      const [child] = await tx`
        INSERT INTO bead_identity (rig_id, local_token, root, child, origin)
        VALUES (${rigId}, '8425.1', 8425, 1, 'minted') RETURNING id`;
      expect(root.id).toBeGreaterThan(0);
      expect(child.id).toBeGreaterThan(0);
    });
  });

  it('an imported hash or multidot token is kept verbatim', async () => {
    await rolledBack(async (tx) => {
      const f = fixtures(tx, 'imported');
      const rigId = await f.rig();
      const [hash] = await tx`
        INSERT INTO bead_identity (rig_id, local_token, origin)
        VALUES (${rigId}, '7vaoz-wmzyw', 'imported') RETURNING local_token`;
      const [multidot] = await tx`
        INSERT INTO bead_identity (rig_id, local_token, origin)
        VALUES (${rigId}, 'abc.def.ghi', 'imported') RETURNING local_token`;
      expect(hash.local_token).toBe('7vaoz-wmzyw');
      expect(multidot.local_token).toBe('abc.def.ghi');
    });
  });

  it('one token and one numeric slot cannot be claimed twice on a rig', async () => {
    await rolledBack(async (tx) => {
      const f = fixtures(tx, 'dup');
      const rigId = await f.rig();
      await tx`INSERT INTO bead_identity (rig_id, local_token, root, child, origin)
               VALUES (${rigId}, '9101', 9101, 0, 'minted')`;
      await expectRefusal(
        tx,
        '23505',
        (sp) => sp`
        INSERT INTO bead_identity (rig_id, local_token, root, child, origin)
        VALUES (${rigId}, '9101', 9101, 0, 'minted')`,
      );
      await expectRefusal(
        tx,
        '23505',
        (sp) => sp`
        INSERT INTO bead_identity (rig_id, local_token, root, child, origin)
        VALUES (${rigId}, '9101-copy', 9101, 0, 'imported')`,
      );
    });
  });
});

describe('identity guards', () => {
  it('a bead identity cannot change rig, token, coordinates or origin', async () => {
    await rolledBack(async (tx) => {
      const f = fixtures(tx, 'immutable');
      const rigId = await f.rig();
      const otherRig = await f.rig();
      const [row] = await tx`
        INSERT INTO bead_identity (rig_id, local_token, root, child, origin)
        VALUES (${rigId}, '9201', 9201, 0, 'minted') RETURNING id`;
      const id = row.id as number;
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE bead_identity SET rig_id = ${otherRig} WHERE id = ${id}`,
      );
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE bead_identity SET local_token = 'x' WHERE id = ${id}`,
      );
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE bead_identity SET root = 1 WHERE id = ${id}`,
      );
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE bead_identity SET child = 5 WHERE id = ${id}`,
      );
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE bead_identity SET origin = 'imported' WHERE id = ${id}`,
      );
      const [after] =
        await tx`SELECT rig_id, local_token, root, child, origin FROM bead_identity WHERE id = ${id}`;
      expect(after).toMatchObject({
        rig_id: rigId,
        local_token: '9201',
        root: 9201,
        child: 0,
        origin: 'minted',
      });
    });
  });

  it('a rig prefix is fixed and its counter only moves forward', async () => {
    await rolledBack(async (tx) => {
      const f = fixtures(tx, 'rig');
      const rigId = await f.rig();
      await tx`UPDATE rig SET next_root = next_root + 1 WHERE id = ${rigId}`;
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE rig SET next_root = next_root - 1 WHERE id = ${rigId}`,
      );
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE rig SET prefix = 'other' WHERE id = ${rigId}`,
      );
      const [after] = await tx`SELECT next_root FROM rig WHERE id = ${rigId}`;
      expect(after.next_root).toBe(2);
    });
  });

  it('a rig and a bead identity are never deleted', async () => {
    await rolledBack(async (tx) => {
      const f = fixtures(tx, 'nodelete');
      const rigId = await f.rig();
      const [row] = await tx`
        INSERT INTO bead_identity (rig_id, local_token, root, child, origin)
        VALUES (${rigId}, '9301', 9301, 0, 'minted') RETURNING id`;
      await expectRefusal(tx, '23503', (sp) => sp`DELETE FROM bead_identity WHERE id = ${row.id}`);
      await expectRefusal(tx, '23503', (sp) => sp`DELETE FROM rig WHERE id = ${rigId}`);
      const [still] = await tx`SELECT count(*)::int AS n FROM bead_identity WHERE id = ${row.id}`;
      expect(still.n).toBe(1);
    });
  });

  it('an issue bead id, once set, never changes or clears', async () => {
    await rolledBack(async (tx) => {
      const f = fixtures(tx, 'beadid');
      const rigId = await f.rig();
      const project = await f.project(rigId);
      const issueId = await f.issue(project.id);
      await tx`UPDATE issue SET bead_id = 'sentinel-prod-9401' WHERE id = ${issueId}`;
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE issue SET bead_id = 'sentinel-prod-9402' WHERE id = ${issueId}`,
      );
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE issue SET bead_id = NULL WHERE id = ${issueId}`,
      );
      const [after] = await tx`SELECT bead_id FROM issue WHERE id = ${issueId}`;
      expect(after.bead_id).toBe('sentinel-prod-9401');
    });
  });

  it('a rig with a project cannot be deleted', async () => {
    await rolledBack(async (tx) => {
      const f = fixtures(tx, 'fkrestrict');
      const rigId = await f.rig();
      await f.project(rigId);
      await expectRefusal(tx, '23503', (sp) => sp`DELETE FROM rig WHERE id = ${rigId}`);
    });
  });
});

describe('the issue link', () => {
  it('deleting the issue releases the link, and detaching by hand does not', async () => {
    await rolledBack(async (tx) => {
      const f = fixtures(tx, 'link');
      const rigId = await f.rig();
      const project = await f.project(rigId);
      const issueId = await f.issue(project.id);
      const [row] = await tx`
        INSERT INTO bead_identity (rig_id, local_token, root, child, origin, issue_id)
        VALUES (${rigId}, '9501', 9501, 0, 'minted', ${issueId}) RETURNING id`;
      const id = row.id as number;

      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE bead_identity SET issue_id = NULL WHERE id = ${id}`,
      );
      const [held] = await tx`SELECT issue_id FROM bead_identity WHERE id = ${id}`;
      expect(held.issue_id).toBe(issueId);

      await tx`DELETE FROM issue WHERE id = ${issueId}`;
      const [released] = await tx`SELECT issue_id FROM bead_identity WHERE id = ${id}`;
      expect(released.issue_id).toBeNull();

      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE bead_identity SET issue_id = ${issueId} WHERE id = ${id}`,
      );
      const [after] = await tx`SELECT issue_id FROM bead_identity WHERE id = ${id}`;
      expect(after.issue_id).toBeNull();
    });
  });

  it('an identity cannot move to another issue', async () => {
    await rolledBack(async (tx) => {
      const f = fixtures(tx, 'move');
      const rigId = await f.rig();
      const project = await f.project(rigId);
      const first = await f.issue(project.id, 1);
      const second = await f.issue(project.id, 2);
      const [row] = await tx`
        INSERT INTO bead_identity (rig_id, local_token, root, child, origin, issue_id)
        VALUES (${rigId}, '9601', 9601, 0, 'minted', ${first}) RETURNING id`;
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE bead_identity SET issue_id = ${second} WHERE id = ${row.id}`,
      );
      const [after] = await tx`SELECT issue_id FROM bead_identity WHERE id = ${row.id}`;
      expect(after.issue_id).toBe(first);
    });
  });
});
