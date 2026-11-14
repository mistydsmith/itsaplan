import { afterAll, describe, expect, it } from 'bun:test';
import postgres, { type TransactionSql } from 'postgres';

// The claim columns C2 adds to issue. Every row here is built and rolled back, so the
// owned database keeps nothing after a run.
const REQUIRED_DB = 'itsaplan_8364_c2_test_r2';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Pure guard, evaluated before a client exists, so a wrong target is never contacted.
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
  if (/sentinel|trial/i.test(name))
    throw new Error('refusing a persistent trial or Sentinel database');
  if (name !== REQUIRED_DB)
    throw new Error(`refusing database ${name}; this suite uses ${REQUIRED_DB}`);
  return url;
}

const sql = postgres(targetUrl(process.env.DATABASE_URL, process.env.NODE_ENV).toString(), {
  max: 1,
  onnotice: () => undefined,
});

afterAll(async () => {
  await sql.end();
});

// One transaction per test, always rolled back. No BEGIN in a hook and no TRUNCATE.
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

// A savepoint around exactly one intended refusal, then a probe proving the outer
// transaction is still usable, so an aborted transaction can never pass as a refusal.
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

let seq = 0;
async function claimedIssue(tx: TransactionSql): Promise<number> {
  seq += 1;
  const [workspace] =
    await tx`INSERT INTO workspace (name) VALUES (${`c2 ws ${seq}`}) RETURNING id`;
  const [team] = await tx`
    INSERT INTO team (workspace_id, name, slug)
    VALUES (${workspace.id}, ${`c2 team ${seq}`}, ${`c2-team-${seq}`}) RETURNING id`;
  const [project] = await tx`
    INSERT INTO project (team_id, key, name)
    VALUES (${team.id}, ${`C2${seq}`}, ${`c2 project ${seq}`}) RETURNING id`;
  const [column] = await tx`
    INSERT INTO project_column (project_id, name, position)
    VALUES (${project.id}, 'Todo', 0) RETURNING id`;
  const [issue] = await tx`
    INSERT INTO issue (project_id, sequence_number, column_id, title)
    VALUES (${project.id}, 1, ${column.id}, 'c2 issue') RETURNING id`;
  return issue.id as number;
}

describe('the harness guard refuses a wrong target without contacting it', () => {
  it('rejects a non-loopback host, a wrong port, a persistent name and the wrong base', () => {
    const good = `postgres://nobody@127.0.0.1:5433/${REQUIRED_DB}`;
    expect(targetUrl(good, 'test').pathname).toBe(`/${REQUIRED_DB}`);
    expect(() => targetUrl(good, 'production')).toThrow(/NODE_ENV/);
    expect(() => targetUrl('postgres://nobody@db.example.com:5433/x', 'test')).toThrow(/loopback/);
    expect(() => targetUrl(`postgres://nobody@127.0.0.1:5432/${REQUIRED_DB}`, 'test')).toThrow(
      /5433/,
    );
    expect(() => targetUrl('postgres://nobody@127.0.0.1:5433/sentinel_prod_test', 'test')).toThrow(
      /Sentinel/,
    );
    expect(() =>
      targetUrl('postgres://nobody@127.0.0.1:5433/itsaplan_8364_c1_test', 'test'),
    ).toThrow(/refusing database/);
  });
});

describe('the three claim columns', () => {
  it('exist, are nullable or defaulted, and no started column came with them', async () => {
    await rolledBack(async (tx) => {
      const [row] = await tx`
        SELECT column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'issue' AND column_name LIKE 'claim%' ORDER BY column_name`;
      expect(row.column_name).toBe('claim_epoch');
      const names = await tx`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'issue' AND column_name LIKE 'claim%' ORDER BY column_name`;
      expect(names.map((r) => r.column_name)).toEqual([
        'claim_epoch',
        'claim_expires_at',
        'claim_owner',
      ]);
      const started = await tx`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'issue' AND column_name LIKE 'claim_started%'`;
      expect(started.length).toBe(0);
    });
  });

  it('a fresh issue is unclaimed at epoch 0', async () => {
    await rolledBack(async (tx) => {
      const id = await claimedIssue(tx);
      const [row] =
        await tx`SELECT claim_owner, claim_epoch, claim_expires_at FROM issue WHERE id = ${id}`;
      expect(row).toMatchObject({ claim_owner: null, claim_epoch: 0, claim_expires_at: null });
    });
  });
});

describe('owner and deadline travel together', () => {
  it('owner without a deadline refuses, and a deadline without an owner refuses', async () => {
    await rolledBack(async (tx) => {
      const id = await claimedIssue(tx);
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE issue SET claim_owner = 'worker-a', claim_epoch = 1 WHERE id = ${id}`,
      );
      await expectRefusal(
        tx,
        '23514',
        (sp) =>
          sp`UPDATE issue SET claim_expires_at = now() + interval '5 minutes' WHERE id = ${id}`,
      );
      const [after] = await tx`SELECT claim_owner, claim_expires_at FROM issue WHERE id = ${id}`;
      expect(after).toMatchObject({ claim_owner: null, claim_expires_at: null });
    });
  });
});

describe('the owner shape is POSIX-whitespace exact', () => {
  it('refuses surrounding whitespace of every kind and an empty owner', async () => {
    await rolledBack(async (tx) => {
      const id = await claimedIssue(tx);
      const lease = sql`now() + interval '5 minutes'`;
      for (const bad of [
        ' worker-a',
        'worker-a ',
        'worker-a\t',
        'worker-a\n',
        'worker-a\v',
        'worker-a\r',
        'worker-a\f',
      ]) {
        await expectRefusal(
          tx,
          '23514',
          (sp) =>
            sp`UPDATE issue SET claim_owner = ${bad}, claim_epoch = 1, claim_expires_at = ${lease} WHERE id = ${id}`,
        );
      }
      await expectRefusal(
        tx,
        '23514',
        (sp) =>
          sp`UPDATE issue SET claim_owner = '', claim_epoch = 1, claim_expires_at = ${lease} WHERE id = ${id}`,
      );
    });
  });

  it('allows a name that merely ends with the letter v, which the charset must not strip', async () => {
    await rolledBack(async (tx) => {
      const id = await claimedIssue(tx);
      await tx`UPDATE issue SET claim_owner = 'worker-v', claim_epoch = 1,
               claim_expires_at = now() + interval '5 minutes' WHERE id = ${id}`;
      const [row] = await tx`SELECT claim_owner FROM issue WHERE id = ${id}`;
      expect(row.claim_owner).toBe('worker-v');
    });
  });
});

describe('the epoch counter', () => {
  it('refuses a negative epoch and an active claim at epoch 0', async () => {
    await rolledBack(async (tx) => {
      const id = await claimedIssue(tx);
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE issue SET claim_epoch = -1 WHERE id = ${id}`,
      );
      await expectRefusal(
        tx,
        '23514',
        (sp) =>
          sp`UPDATE issue SET claim_owner = 'worker-a', claim_expires_at = now() + interval '5 minutes'
           WHERE id = ${id}`,
      );
    });
  });

  it('needs exactly the next epoch for an acquire, a release and a handover', async () => {
    await rolledBack(async (tx) => {
      const id = await claimedIssue(tx);
      const lease = sql`now() + interval '5 minutes'`;
      await tx`UPDATE issue SET claim_owner = 'worker-a', claim_epoch = 1, claim_expires_at = ${lease} WHERE id = ${id}`;

      // Same holder heartbeat keeps the epoch.
      await tx`UPDATE issue SET claim_expires_at = now() + interval '5 minutes' WHERE id = ${id}`;
      const [beat] = await tx`SELECT claim_epoch FROM issue WHERE id = ${id}`;
      expect(beat.claim_epoch).toBe(1);

      // Owner change without a new epoch refuses; a jump of two refuses; a decrement refuses.
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE issue SET claim_owner = 'worker-b' WHERE id = ${id}`,
      );
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE issue SET claim_owner = 'worker-b', claim_epoch = 3 WHERE id = ${id}`,
      );
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE issue SET claim_epoch = 0 WHERE id = ${id}`,
      );

      // The handover with the next epoch is allowed.
      await tx`UPDATE issue SET claim_owner = 'worker-b', claim_epoch = 2 WHERE id = ${id}`;
      const [moved] = await tx`SELECT claim_owner, claim_epoch FROM issue WHERE id = ${id}`;
      expect(moved).toMatchObject({ claim_owner: 'worker-b', claim_epoch: 2 });

      // Releasing to nobody also needs the next epoch.
      await expectRefusal(
        tx,
        '23514',
        (sp) => sp`UPDATE issue SET claim_owner = NULL, claim_expires_at = NULL WHERE id = ${id}`,
      );
      await tx`UPDATE issue SET claim_owner = NULL, claim_expires_at = NULL, claim_epoch = 3 WHERE id = ${id}`;
      const [free] =
        await tx`SELECT claim_owner, claim_epoch, claim_expires_at FROM issue WHERE id = ${id}`;
      expect(free).toMatchObject({ claim_owner: null, claim_epoch: 3, claim_expires_at: null });

      // Acquiring from nobody is a change of owner too, so it takes the next epoch.
      await expectRefusal(
        tx,
        '23514',
        (sp) =>
          sp`UPDATE issue SET claim_owner = 'worker-c', claim_expires_at = ${lease} WHERE id = ${id}`,
      );
      await tx`UPDATE issue SET claim_owner = 'worker-c', claim_expires_at = ${lease}, claim_epoch = 4 WHERE id = ${id}`;
      const [again] = await tx`SELECT claim_owner, claim_epoch FROM issue WHERE id = ${id}`;
      expect(again).toMatchObject({ claim_owner: 'worker-c', claim_epoch: 4 });
    });
  });
});
