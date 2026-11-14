import { afterAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  DEFAULT_ISSUE_CLAIM_LEASE_SECONDS,
  claimIssue,
  heartbeatClaim,
  reclaimIssue,
  releaseClaim,
  type ClaimTransaction,
} from '../issue-claim';

// The C3a claim store, exercised against a real Postgres. Every row this file creates is
// deleted by its exact id at the end of the case that made it, so the proof database
// keeps no fixtures; nothing truncates, resets or drops anything.
const REQUIRED_DB = 'itsaplan_8364_c3_test';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Pure guard, evaluated before a client exists, so a wrong target is never contacted.
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

// Two independent connections, so the race cases contend in the database rather than in
// this process. Each pool holds one connection.
const clientA = postgres(url, { max: 1, onnotice: () => undefined });
const clientB = postgres(url, { max: 1, onnotice: () => undefined });
const dbA = drizzle(clientA);
const dbB = drizzle(clientB);

afterAll(async () => {
  await clientA.end();
  await clientB.end();
});

// Every row this file creates is remembered by id and deleted by that id alone, so a
// same-named or same-prefixed row that this file did not create can never be removed.
const made = {
  issue: [] as number[],
  column: [] as number[],
  project: [] as number[],
  team: [] as number[],
  workspace: [] as number[],
};

async function fixtureIssue(): Promise<number> {
  const [workspace] = await clientA`
    INSERT INTO workspace (name) VALUES ('c3 claim ws') RETURNING id`;
  made.workspace.push(workspace.id as number);
  const [team] = await clientA`
    INSERT INTO team (workspace_id, name, slug)
    VALUES (${workspace.id}, 'c3 claim team', ${`c3-claim-${workspace.id}`}) RETURNING id`;
  made.team.push(team.id as number);
  const [project] = await clientA`
    INSERT INTO project (team_id, key, name)
    VALUES (${team.id}, ${`C3${workspace.id}`}, 'c3 claim project') RETURNING id`;
  made.project.push(project.id as number);
  const [column] = await clientA`
    INSERT INTO project_column (project_id, name, position)
    VALUES (${project.id}, 'Todo', 0) RETURNING id`;
  made.column.push(column.id as number);
  const [issue] = await clientA`
    INSERT INTO issue (project_id, sequence_number, column_id, title)
    VALUES (${project.id}, 1, ${column.id}, 'c3 claim issue') RETURNING id`;
  made.issue.push(issue.id as number);
  return issue.id as number;
}

// Deletes exactly the ids this file created, children before parents, and nothing else.
async function cleanUp(): Promise<void> {
  for (const id of made.issue.splice(0)) await clientA`DELETE FROM issue WHERE id = ${id}`;
  for (const id of made.column.splice(0))
    await clientA`DELETE FROM project_column WHERE id = ${id}`;
  for (const id of made.project.splice(0)) await clientA`DELETE FROM project WHERE id = ${id}`;
  for (const id of made.team.splice(0)) await clientA`DELETE FROM team WHERE id = ${id}`;
  for (const id of made.workspace.splice(0)) await clientA`DELETE FROM workspace WHERE id = ${id}`;
}

// Runs the body in one committed transaction on connection A, so a race case can make
// its claim visible to connection B. Rollback is the default for the single-connection
// cases instead.
async function committed<T>(work: (tx: ClaimTransaction) => Promise<T>): Promise<T> {
  return dbA.transaction(async (tx) => work(tx as unknown as ClaimTransaction));
}

async function rolledBack(work: (tx: ClaimTransaction) => Promise<void>): Promise<void> {
  const rollback = Symbol('rollback');
  try {
    await dbA.transaction(async (tx) => {
      await work(tx as unknown as ClaimTransaction);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

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

describe('argument and boundary refusals', () => {
  it('refuses malformed arguments before touching the row', async () => {
    try {
      const id = await fixtureIssue();
      await rolledBack(async (tx) => {
        expect((await claimIssue(tx, { issueId: 0, actor: 'a', expectedEpoch: 0 })).ok).toBe(false);
        expect((await claimIssue(tx, { issueId: id, actor: ' a', expectedEpoch: 0 })).ok).toBe(
          false,
        );
        expect((await claimIssue(tx, { issueId: id, actor: 'a\t', expectedEpoch: 0 })).ok).toBe(
          false,
        );
        expect((await claimIssue(tx, { issueId: id, actor: '', expectedEpoch: 0 })).ok).toBe(false);
        expect((await claimIssue(tx, { issueId: id, actor: 'a', expectedEpoch: -1 })).ok).toBe(
          false,
        );
        expect((await claimIssue(tx, { issueId: id, actor: 'a', expectedEpoch: 1.5 })).ok).toBe(
          false,
        );
        expect((await claimIssue(tx, { issueId: id, actor: 'a', expectedEpoch: true })).ok).toBe(
          false,
        );
        expect((await claimIssue(tx, { issueId: id, actor: 'a', expectedEpoch: 0 })).ok).toBe(true);
      });
    } finally {
      await cleanUp();
    }
  });

  it('refuses a row that does not exist', async () => {
    await rolledBack(async (tx) => {
      const out = await claimIssue(tx, { issueId: 2_147_000_000, actor: 'a', expectedEpoch: 0 });
      expect(out).toMatchObject({ ok: false, code: 'missing-row' });
    });
  });
});

describe('claim, idempotence and stealing', () => {
  it('exports the measured lease default and uses it, not a caller value', async () => {
    expect(DEFAULT_ISSUE_CLAIM_LEASE_SECONDS).toBe(300);
    try {
      const id = await fixtureIssue();
      await rolledBack(async (tx) => {
        const out = await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 });
        expect(out.ok).toBe(true);
        if (!out.ok || !out.claim.expiresAt) return;
        const seconds = Math.round((out.claim.expiresAt.getTime() - Date.now()) / 1000);
        expect(seconds).toBeGreaterThan(295);
        expect(seconds).toBeLessThanOrEqual(300);
      });
    } finally {
      await cleanUp();
    }
  });

  it('an unclaimed row takes the first epoch and a paired deadline', async () => {
    try {
      const id = await fixtureIssue();
      await rolledBack(async (tx) => {
        const out = await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.claim).toMatchObject({ owner: 'worker-a', epoch: 1 });
        expect(out.claim.expiresAt instanceof Date).toBe(true);
        expect(out.unchanged).toBe(false);
      });
    } finally {
      await cleanUp();
    }
  });

  it('a live claim by the same actor is returned untouched, epoch and deadline kept', async () => {
    try {
      const id = await fixtureIssue();
      await committed(async (tx) => {
        const first = await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 });
        expect(first.ok).toBe(true);
      });
      const [held] =
        await clientA`SELECT claim_epoch, claim_expires_at FROM issue WHERE id = ${id}`;
      await committed(async (tx) => {
        const again = await claimIssue(tx, {
          issueId: id,
          actor: 'worker-a',
          expectedEpoch: held.claim_epoch,
        });
        expect(again.ok).toBe(true);
        if (!again.ok) return;
        expect(again.unchanged).toBe(true);
        expect(again.claim.epoch).toBe(held.claim_epoch);
        // The raw driver read hands back a string; compare instants, not representations.
        expect(again.claim.expiresAt?.getTime()).toBe(new Date(held.claim_expires_at).getTime());
      });
    } finally {
      await cleanUp();
    }
  });

  it('a live claim by another actor cannot be stolen', async () => {
    try {
      const id = await fixtureIssue();
      await committed(async (tx) => {
        expect(
          (await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 })).ok,
        ).toBe(true);
      });
      await committed(async (tx) => {
        const out = await claimIssue(tx, { issueId: id, actor: 'worker-b', expectedEpoch: 1 });
        expect(out).toMatchObject({ ok: false, code: 'live-other-owner' });
      });
    } finally {
      await cleanUp();
    }
  });

  it('a stale expected epoch refuses and reports the authoritative row', async () => {
    try {
      const id = await fixtureIssue();
      await committed(async (tx) => {
        expect(
          (await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 })).ok,
        ).toBe(true);
      });
      await committed(async (tx) => {
        const out = await claimIssue(tx, { issueId: id, actor: 'worker-b', expectedEpoch: 0 });
        expect(out).toMatchObject({ ok: false, code: 'stale-epoch' });
        if (out.ok || !out.authoritative) return;
        expect(out.authoritative).toMatchObject({ owner: 'worker-a', epoch: 1 });
      });
    } finally {
      await cleanUp();
    }
  });
});

describe('reclaim, heartbeat and release', () => {
  it('reclaims only after the lease lapses, and raises the epoch even for the same actor', async () => {
    try {
      const id = await fixtureIssue();
      await committed(async (tx) => {
        expect(
          (await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 })).ok,
        ).toBe(true);
      });
      // Push the deadline into the past so the boundary is the database's own clock.
      await clientA`UPDATE issue SET claim_expires_at = now() - interval '1 second' WHERE id = ${id}`;
      await committed(async (tx) => {
        const early = await reclaimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 1 });
        expect(early.ok).toBe(true);
        if (!early.ok) return;
        expect(early.claim).toMatchObject({ owner: 'worker-a', epoch: 2 });
        expect(early.claim.expiresAt).not.toBeNull();
      });
    } finally {
      await cleanUp();
    }
  });

  it('refuses a reclaim of a live claim and of an unclaimed row', async () => {
    try {
      const id = await fixtureIssue();
      await committed(async (tx) => {
        expect(
          (await reclaimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 })).ok,
        ).toBe(false);
        expect(
          (await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 })).ok,
        ).toBe(true);
      });
      await committed(async (tx) => {
        expect(
          await reclaimIssue(tx, { issueId: id, actor: 'worker-b', expectedEpoch: 1 }),
        ).toMatchObject({
          ok: false,
          code: 'not-expired',
        });
      });
    } finally {
      await cleanUp();
    }
  });

  it('a heartbeat extends the deadline and keeps the epoch', async () => {
    try {
      const id = await fixtureIssue();
      await committed(async (tx) => {
        expect(
          (await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 })).ok,
        ).toBe(true);
      });
      const [before] =
        await clientA`SELECT claim_epoch, claim_expires_at FROM issue WHERE id = ${id}`;
      await clientA`UPDATE issue SET claim_expires_at = now() + interval '1 minute' WHERE id = ${id}`;
      await committed(async (tx) => {
        const beat = await heartbeatClaim(tx, {
          issueId: id,
          actor: 'worker-a',
          expectedEpoch: before.claim_epoch,
        });
        expect(beat.ok).toBe(true);
        if (!beat.ok) return;
        expect(beat.claim.epoch).toBe(before.claim_epoch);
      });
    } finally {
      await cleanUp();
    }
  });

  it('a heartbeat after the lease lapsed refuses, and a wrong owner refuses', async () => {
    try {
      const id = await fixtureIssue();
      await committed(async (tx) => {
        expect(
          (await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 })).ok,
        ).toBe(true);
      });
      await committed(async (tx) => {
        expect(
          await heartbeatClaim(tx, { issueId: id, actor: 'worker-b', expectedEpoch: 1 }),
        ).toMatchObject({
          ok: false,
          code: 'wrong-owner',
        });
      });
      await clientA`UPDATE issue SET claim_expires_at = now() - interval '1 second' WHERE id = ${id}`;
      await committed(async (tx) => {
        expect(
          await heartbeatClaim(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 1 }),
        ).toMatchObject({
          ok: false,
          code: 'expired-lease',
        });
      });
    } finally {
      await cleanUp();
    }
  });

  it('a release clears owner and deadline together and moves the epoch by one', async () => {
    try {
      const id = await fixtureIssue();
      await committed(async (tx) => {
        expect(
          (await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 })).ok,
        ).toBe(true);
      });
      await committed(async (tx) => {
        const released = await releaseClaim(tx, {
          issueId: id,
          actor: 'worker-a',
          expectedEpoch: 1,
        });
        expect(released.ok).toBe(true);
        if (!released.ok) return;
        expect(released.claim).toMatchObject({ owner: null, epoch: 2, expiresAt: null });
      });
      // A released row can be claimed again, by anyone, at the epoch it now holds.
      await committed(async (tx) => {
        const again = await claimIssue(tx, { issueId: id, actor: 'worker-b', expectedEpoch: 2 });
        expect(again.ok).toBe(true);
        if (!again.ok) return;
        expect(again.claim).toMatchObject({ owner: 'worker-b', epoch: 3 });
      });
    } finally {
      await cleanUp();
    }
  });

  it('a release by nobody or by another actor refuses', async () => {
    try {
      const id = await fixtureIssue();
      await committed(async (tx) => {
        expect(
          await releaseClaim(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 }),
        ).toMatchObject({
          ok: false,
          code: 'not-claimed',
        });
      });
      await committed(async (tx) => {
        expect(
          (await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 })).ok,
        ).toBe(true);
      });
      await committed(async (tx) => {
        expect(
          await releaseClaim(tx, { issueId: id, actor: 'worker-b', expectedEpoch: 1 }),
        ).toMatchObject({
          ok: false,
          code: 'wrong-owner',
        });
      });
    } finally {
      await cleanUp();
    }
  });
});

describe('real races across two connections', () => {
  it('two competing claims on one unclaimed row: exactly one wins', async () => {
    try {
      const id = await fixtureIssue();
      const results = await Promise.all([
        committed((tx) => claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 })),
        dbB.transaction((tx) =>
          claimIssue(tx as unknown as ClaimTransaction, {
            issueId: id,
            actor: 'worker-b',
            expectedEpoch: 0,
          }),
        ),
      ]);
      const wins = results.filter((r) => r.ok);
      const losses = results.filter((r) => !r.ok);
      expect(wins.length).toBe(1);
      expect(losses.length).toBe(1);
      expect(['stale-epoch', 'live-other-owner']).toContain((losses[0] as { code: string }).code);
      const [row] = await clientA`SELECT claim_owner, claim_epoch FROM issue WHERE id = ${id}`;
      expect(row.claim_epoch).toBe(1);
      expect(['worker-a', 'worker-b']).toContain(row.claim_owner);
    } finally {
      await cleanUp();
    }
  });

  it('serial retries from four actors mint exactly one epoch', async () => {
    // These four attempts run one after another on one connection, so this is not a
    // race: it proves that repeated attempts cannot mint a second epoch, and the
    // two-connection case above is what proves the concurrent behaviour.
    try {
      const id = await fixtureIssue();
      const attempts: { ok: boolean }[] = [];
      for (const actor of ['w1', 'w2', 'w3', 'w4']) {
        attempts.push(
          await committed((tx) => claimIssue(tx, { issueId: id, actor, expectedEpoch: 0 })),
        );
      }
      expect(attempts.filter((r) => r.ok).length).toBe(1);
      const [row] = await clientA`SELECT claim_epoch FROM issue WHERE id = ${id}`;
      expect(row.claim_epoch).toBe(1);
    } finally {
      await cleanUp();
    }
  });

  it('a stale heartbeat or release after a reassignment cannot touch the new owner', async () => {
    try {
      const id = await fixtureIssue();
      await committed(async (tx) => {
        expect(
          (await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 })).ok,
        ).toBe(true);
      });
      // A lets its lease lapse, B takes the row at the next epoch.
      await clientA`UPDATE issue SET claim_expires_at = now() - interval '1 second' WHERE id = ${id}`;
      await committed(async (tx) => {
        const taken = await reclaimIssue(tx, { issueId: id, actor: 'worker-b', expectedEpoch: 1 });
        expect(taken.ok).toBe(true);
      });
      // A's stale epoch must not extend or release B's claim.
      await committed(async (tx) => {
        expect(
          await heartbeatClaim(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 1 }),
        ).toMatchObject({
          ok: false,
          code: 'stale-epoch',
        });
        expect(
          await releaseClaim(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 1 }),
        ).toMatchObject({
          ok: false,
          code: 'stale-epoch',
        });
      });
      const [row] = await clientA`SELECT claim_owner, claim_epoch FROM issue WHERE id = ${id}`;
      expect(row).toMatchObject({ claim_owner: 'worker-b', claim_epoch: 2 });
    } finally {
      await cleanUp();
    }
  });

  it('an uncommitted claim is invisible to another connection until it commits', async () => {
    try {
      const id = await fixtureIssue();
      const rollback = Symbol('rollback');
      let seenInside: unknown = 'not-read';
      try {
        await dbA.transaction(async (tx) => {
          const out = await claimIssue(tx as unknown as ClaimTransaction, {
            issueId: id,
            actor: 'worker-a',
            expectedEpoch: 0,
          });
          expect(out.ok).toBe(true);
          const [other] = await clientB`SELECT claim_owner FROM issue WHERE id = ${id}`;
          seenInside = other.claim_owner;
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      expect(seenInside).toBeNull();
      const [after] = await clientA`SELECT claim_owner, claim_epoch FROM issue WHERE id = ${id}`;
      expect(after).toMatchObject({ claim_owner: null, claim_epoch: 0 });
    } finally {
      await cleanUp();
    }
  });

  it('a transaction that claims and then refuses leaves no claim and no native write', async () => {
    try {
      const id = await fixtureIssue();
      const [column] = await clientA`SELECT column_id FROM issue WHERE id = ${id}`;
      const rollback = Symbol('rollback');
      try {
        await dbA.transaction(async (tx) => {
          const out = await claimIssue(tx as unknown as ClaimTransaction, {
            issueId: id,
            actor: 'worker-a',
            expectedEpoch: 0,
          });
          expect(out.ok).toBe(true);
          // A representative native write in the same transaction as the claim.
          await tx.execute(sql`UPDATE issue SET title = 'c3 claimed and moved' WHERE id = ${id}`);
          expect(column.column_id).toBeGreaterThan(0);
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const [after] =
        await clientA`SELECT claim_owner, claim_epoch, title FROM issue WHERE id = ${id}`;
      expect(after).toMatchObject({ claim_owner: null, claim_epoch: 0, title: 'c3 claim issue' });
    } finally {
      await cleanUp();
    }
  });
});

describe('time comes from the server after the lock, and the lease is fixed', () => {
  it('a transaction that waited past the deadline refuses a heartbeat', async () => {
    // The deadline is set from the transaction's own now(), then the transaction sleeps
    // past it. Judging expiry on the transaction's start time would allow the heartbeat;
    // the server clock read after the lock refuses it.
    try {
      const id = await fixtureIssue();
      const rollback = Symbol('rollback');
      try {
        await dbA.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE issue SET claim_owner = 'worker-a', claim_epoch = 1,
                    claim_expires_at = now() + interval '100 milliseconds' WHERE id = ${id}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
          const out = await heartbeatClaim(tx as unknown as ClaimTransaction, {
            issueId: id,
            actor: 'worker-a',
            expectedEpoch: 1,
          });
          expect(out).toMatchObject({ ok: false, code: 'expired-lease' });
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
    } finally {
      await cleanUp();
    }
  });

  it('a call that waited for the row lock judges expiry on the clock it resumed at', async () => {
    try {
      const id = await fixtureIssue();
      await committed(async (tx) => {
        expect(
          (await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 })).ok,
        ).toBe(true);
      });
      // The lease lapses 100 ms from now, and another transaction holds the row lock for
      // longer than that, so the waiting heartbeat only gets the lock after the lapse.
      await clientA`UPDATE issue SET claim_expires_at = now() + interval '100 milliseconds' WHERE id = ${id}`;
      let holder: Promise<unknown> | null = null;
      const rollback = Symbol('rollback');
      holder = dbA
        .transaction(async (tx) => {
          await tx.execute(sql`SELECT id FROM issue WHERE id = ${id} FOR UPDATE`);
          await new Promise((resolve) => setTimeout(resolve, 350));
          throw rollback;
        })
        .catch((error) => {
          if (error !== rollback) throw error;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const out = await dbB.transaction((tx) =>
        heartbeatClaim(tx as unknown as ClaimTransaction, {
          issueId: id,
          actor: 'worker-a',
          expectedEpoch: 1,
        }),
      );
      await holder;
      expect(out).toMatchObject({ ok: false, code: 'expired-lease' });
    } finally {
      await cleanUp();
    }
  });

  it('an extra lease field on the input cannot shorten or lengthen the fixed lease', async () => {
    try {
      const id = await fixtureIssue();
      await rolledBack(async (tx) => {
        const tampered = {
          issueId: id,
          actor: 'worker-a',
          expectedEpoch: 0,
          leaseSeconds: 1,
        } as unknown as { issueId: unknown; actor: unknown; expectedEpoch: unknown };
        const out = await claimIssue(tx, tampered);
        expect(out.ok).toBe(true);
        if (!out.ok || !out.claim.expiresAt) return;
        const seconds = (out.claim.expiresAt.getTime() - Date.now()) / 1000;
        expect(seconds).toBeGreaterThan(295);
        expect(seconds).toBeLessThanOrEqual(DEFAULT_ISSUE_CLAIM_LEASE_SECONDS + 1);
      });
    } finally {
      await cleanUp();
    }
  });

  it('a row this file did not create survives every cleanup', async () => {
    // A sentinel with the same prefixes the old LIKE-based cleanup would have matched.
    const [sentinelWorkspace] = await clientA`
      INSERT INTO workspace (name) VALUES ('c3 claim ws') RETURNING id`;
    const [sentinelTeam] = await clientA`
      INSERT INTO team (workspace_id, name, slug)
      VALUES (${sentinelWorkspace.id}, 'c3 claim team', 'c3-claim-sentinel') RETURNING id`;
    const [sentinelProject] = await clientA`
      INSERT INTO project (team_id, key, name)
      VALUES (${sentinelTeam.id}, 'C3SENTINEL', 'c3 claim sentinel') RETURNING id`;
    try {
      const id = await fixtureIssue();
      await committed(async (tx) => {
        expect(
          (await claimIssue(tx, { issueId: id, actor: 'worker-a', expectedEpoch: 0 })).ok,
        ).toBe(true);
      });
      await cleanUp();
      const [still] =
        await clientA`SELECT count(*)::int AS n FROM project WHERE id = ${sentinelProject.id}`;
      expect(still.n).toBe(1);
    } finally {
      await clientA`DELETE FROM project WHERE id = ${sentinelProject.id}`;
      await clientA`DELETE FROM team WHERE id = ${sentinelTeam.id}`;
      await clientA`DELETE FROM workspace WHERE id = ${sentinelWorkspace.id}`;
      await cleanUp();
    }
  });
});
