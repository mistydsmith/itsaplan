// apps/api/src/modules/issues/__tests__/integration/landing-record-storage.test.ts
// sentinel-prod-8429 unit 6 witness - PREPARED for Root's serial D2 run, never executed from this lane.
// Targets the CT adapter at 5674a1bd through Unit 5 recordLanding, so the move runs the real native updateIssue. Refs are
// always the full form. Every case seeds one owned workspace/project/rig/columns/card/claim and cleans captured ids only;
// the rig and bead_identity are tombstones and stay. No reset, no trigger disable, no ledger delete.

import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';

import {
  assertLandingTargetGuard,
  CLOSE_REPO_KEY,
  landingD2Ready,
  TARGET_REF,
} from './landing-record-storage-fixtures';

const READY = landingD2Ready();

// Everything below touches the database, so nothing is imported until the guard has passed.
type Deps = {
  db: (typeof import('@repo/db'))['db'];
  sql: (typeof import('drizzle-orm'))['sql'];
  storage: typeof import('../../landing-record-storage');
  landing: typeof import('../../../../../../../scripts/landing-record');
  fx: typeof import('./landing-record-storage-fixtures');
};
let D: Deps | null = null;
if (READY) {
  assertLandingTargetGuard();
  const [schema, orm, storage, landing, fx] = await Promise.all([
    import('@repo/db'),
    import('drizzle-orm'),
    import('../../landing-record-storage'),
    import('../../../../../../../scripts/landing-record'),
    import('./landing-record-storage-fixtures'),
  ]);
  D = { db: schema.db, sql: orm.sql, storage, landing, fx };
}

const d2 = READY ? describe : describe.skip;

/** Rows the seed created, so cleanup reaches exactly these and nothing else. */
interface Seeded {
  workspaceId: number;
  teamId: number;
  projectId: number;
  rigId: number;
  startedColumnId: number;
  completedColumnId: number;
  issueId: number;
  closerUserId: string;
  beadId: string;
  claimEpoch: number;
  rigPrefix: string;
  repo: import('./landing-record-storage-fixtures').CloseRepo;
}

/**
 * One owned workspace, project, rig, two columns, a closer user and a claimed card.
 *
 * WHY raw SQL: the fixture must not depend on the code under test to build the state that code is judged on, and the
 * sequence numbers and claim columns are not reachable through the API helpers this suite has.
 */
/** The seed and the cleanup are the fixtures' own functions, so the test cannot drift from the verified schema. */
async function seedOwned(runId: string) {
  const { fx, db, sql } = D as Deps;
  return fx.seed(db as never, sql as never, runId);
}

async function cleanupOwned(owned: Awaited<ReturnType<typeof seedOwned>>): Promise<void> {
  const { fx, db, sql } = D as Deps;
  await fx.cleanup(db as never, sql as never, owned);
}

/** The receipt Unit 5 needs, naming the fixture's own columns and tests. */
function receiptFor(seedRun: Seeded, candidateSha: string, baseSha: string) {
  return {
    id: `r-${seedRun.beadId}`,
    itemKey: seedRun.beadId,
    candidateSha,
    baseSha,
    author: 'dsh',
    allowedPaths: ['apps/api/src/modules/issues/landing-record-storage.ts'],
    namedTests: ['landing witness'],
    outcomes: [{ name: 'landing witness', passed: 1, failed: 0 }],
  };
}

function verdictFor(receipt: { candidateSha: string }) {
  return {
    id: `v-${receipt.candidateSha}`,
    reviewer: 'qwen-1959',
    sha: receipt.candidateSha,
    decision: 'PASS',
    sequence: 1,
  };
}

/** The storage under test, pointed at the fixture's completed column and the manifest key. */
function storageFor(seedRun: Seeded, onPid?: (pid: number) => void) {
  const { storage, db } = D as Deps;
  // WHY client is passed explicitly: at 5674 the constructor requires it (client.transaction is not optional), and
  // leaving it out would fail to compile before it ever failed to open a transaction.
  return storage.nativeRecordStorage({
    completedColumnId: seedRun.completedColumnId,
    closeRepoKey: CLOSE_REPO_KEY,
    closerUserId: seedRun.closerUserId,
    client: {
      transaction: (fn) =>
        db.transaction(async (tx) => {
          const [pid] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
          onPid?.(Number(pid.pid));
          return fn(tx);
        }) as never,
    },
  });
}

/** The Unit 5 input for one witness, so the four cases cannot drift apart in their fixtures. */
function inputFor(
  seedRun: Seeded,
  storage: ReturnType<typeof storageFor>,
  sha: string,
  base: string,
) {
  const receipt = receiptFor(seedRun, sha, base);
  return {
    publication: {
      published: true,
      landed: true,
      partial: false,
      reason: 'published',
      candidateSha: sha,
      targetRef: TARGET_REF,
      remoteSha: sha,
      git: {
        eligible: true,
        reason: 'eligible',
        facts: {
          candidateSha: sha,
          baseSha: base,
          targetSha: base,
          subject: `${seedRun.beadId}: witness`,
          body: '',
          changedPaths: receipt.allowedPaths,
        },
      },
    },
    item: {
      itemKey: seedRun.beadId,
      projectId: seedRun.projectId,
      columnId: seedRun.startedColumnId,
    },
    receipts: [receipt],
    verdicts: [verdictFor(receipt)],
    completedColumnId: seedRun.completedColumnId,
    columns: [
      { id: seedRun.startedColumnId, projectId: seedRun.projectId, stateType: 'started' },
      { id: seedRun.completedColumnId, projectId: seedRun.projectId, stateType: 'completed' },
    ],
    storage,
    actorName: seedRun.closerUserId,
  };
}

/**
 * Rows from a raw statement.
 *
 * WHY a helper: drizzle's execute hands back an ARRAY of row objects in this stack, while my first version read `.rows`
 * and silently compared undefined - so every count and every wait assertion was meaningless. One reader, one shape.
 */
async function rowsOf(query: unknown): Promise<Record<string, unknown>[]> {
  const { db } = D as Deps;
  const out = (await db.execute(query as never)) as unknown;
  if (Array.isArray(out)) return out as Record<string, unknown>[];
  const maybe = out as { rows?: Record<string, unknown>[] };
  return maybe.rows ?? [];
}

/** The single integer a count statement returns, or 0 when the statement produced nothing. */
async function countOf(query: unknown): Promise<number> {
  const [row] = await rowsOf(query as never);
  const value = row?.n ?? row?.count ?? 0;
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/** Observe the exact waiting transaction and its blocker, never an unrelated backend. */
async function waitOn(pid: () => number, holder?: () => number): Promise<void> {
  for (let n = 0; n < 100; n++) {
    if (pid()) {
      const rows = await rowsOf(sql`SELECT pid, pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE pid = ${pid()} AND wait_event_type = 'Lock'`);
      if (rows.length && (!holder || (rows[0].blockers as number[]).includes(holder()))) return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`expected backend ${pid()} to wait${holder ? ` on ${holder()}` : ''}`);
}

const bounded = <T>(p: Promise<T>) =>
  Promise.race([
    p,
    Bun.sleep(10000).then(() => {
      throw new Error('holder did not reach native close');
    }),
  ]);

d2('the native landing witness', () => {
  async function seedAndClean(run: (seedRun: Seeded) => Promise<void>): Promise<void> {
    const { fx } = D as Deps;
    const owned = await seedOwned(fx.landingRunId());
    const repo = fx.closeRepo(fx.landingRunId(), owned.rigPrefix);
    try {
      await fx.withCloseOwner(repo, () => run({ ...owned, repo }));
    } finally {
      repo.cleanup();
      await cleanupOwned(owned);
    }
  }

  function pausedStorage(seedRun: Seeded) {
    let pid = 0;
    const base = storageFor(seedRun, (p) => {
      pid = p;
    });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => {
      entered = r;
    });
    const storage: typeof base = {
      transaction: (fn) =>
        base.transaction(async (tx) => {
          const value = await fn(tx);
          entered();
          await held;
          return value;
        }),
    };
    return { storage, entered: enteredP, release, pid: () => pid };
  }

  it('1: the exact second transaction waits, then the same candidate records once', async () => {
    await seedAndClean(async (s) => {
      const { landing } = D as Deps;
      const held = pausedStorage(s);
      let secondPid = 0;
      const first = landing.recordLanding(
        inputFor(s, held.storage, s.repo.candidateSha, s.repo.baseSha),
      );
      let second: typeof first | undefined;
      try {
        await bounded(held.entered);
        second = landing.recordLanding(
          inputFor(
            s,
            storageFor(s, (p) => {
              secondPid = p;
            }),
            s.repo.candidateSha,
            s.repo.baseSha,
          ),
        );
        await waitOn(() => secondPid, held.pid);
      } finally {
        held.release();
        await first;
      }
      const outcomes = await Promise.all([first, second!]);
      console.log('owned concurrent results', JSON.stringify(outcomes));
      expect(outcomes.map((o) => o.recorded)).toEqual([true, true]);
      expect(outcomes.filter((o) => o.replayed)).toHaveLength(1);
      expect(
        await countOf(
          sql`SELECT count(*)::int AS n FROM issue_activity WHERE issue_id = ${s.issueId} AND payload->>'logicalKind' = 'landing_full'`,
        ),
      ).toBe(1);
      const [row] = await rowsOf(
        sql`SELECT column_id, claim_owner, claim_epoch FROM issue WHERE id = ${s.issueId}`,
      );
      expect([row.column_id, row.claim_owner, Number(row.claim_epoch)]).toEqual([
        s.completedColumnId,
        null,
        2,
      ]);
    });
  }, 30000);

  it('2: throwing after real append/update restores column, claim, status and activity', async () => {
    await seedAndClean(async (s) => {
      const { landing } = D as Deps;
      const base = storageFor(s);
      let reached = false;
      const throwing: typeof base = {
        transaction: (fn) =>
          base.transaction(async (tx) => {
            await fn(tx);
            reached = true;
            throw new Error('throw after real append/update');
          }),
      };
      const out = await landing.recordLanding(
        inputFor(s, throwing, s.repo.candidateSha, s.repo.baseSha),
      );
      expect([out.code, out.recorded, reached]).toEqual(['STORAGE_FAILED', false, true]);
      const [row] = await rowsOf(
        sql`SELECT column_id, claim_owner, claim_epoch FROM issue WHERE id = ${s.issueId}`,
      );
      expect([row.column_id, row.claim_owner, Number(row.claim_epoch)]).toEqual([
        s.startedColumnId,
        s.closerUserId,
        s.claimEpoch,
      ]);
      expect(
        await countOf(
          sql`SELECT count(*)::int AS n FROM issue_activity WHERE issue_id = ${s.issueId}`,
        ),
      ).toBe(0);
      expect(
        await countOf(
          sql`SELECT count(*)::int AS n FROM issue_status WHERE issue_id = ${s.issueId}`,
        ),
      ).toBe(0);
      expect(
        await countOf(
          sql`SELECT count(*)::int AS n FROM notification_delivery WHERE payload->>'issueId' = ${String(s.issueId)}`,
        ),
      ).toBe(0);
    });
  }, 30000);

  it('3: a database retype refuses the stale completed descriptor without moving', async () => {
    await seedAndClean(async (s) => {
      const { landing } = D as Deps;
      await rowsOf(
        sql`UPDATE project_column SET state_type = 'started' WHERE id = ${s.completedColumnId}`,
      );
      const out = await landing.recordLanding(
        inputFor(s, storageFor(s), s.repo.candidateSha, s.repo.baseSha),
      );
      expect([out.code, out.recorded]).toEqual(['STORAGE_FAILED', false]);
      expect(out.reason).toContain('COLUMN_NOT_COMPLETED');
      const [row] = await rowsOf(sql`SELECT column_id FROM issue WHERE id = ${s.issueId}`);
      expect(row.column_id).toBe(s.startedColumnId);
    });
  }, 30000);

  it('4: the exact retype backend waits on the completed column until commit', async () => {
    await seedAndClean(async (s) => {
      const { landing, db } = D as Deps;
      const held = pausedStorage(s);
      let retypePid = 0;
      const first = landing.recordLanding(
        inputFor(s, held.storage, s.repo.candidateSha, s.repo.baseSha),
      );
      let retype: Promise<unknown> | undefined;
      try {
        await bounded(held.entered);
        retype = db.transaction(async (tx) => {
          const [pid] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
          retypePid = Number(pid.pid);
          await tx.execute(
            sql`UPDATE project_column SET state_type = 'started' WHERE id = ${s.completedColumnId}`,
          );
        });
        await waitOn(() => retypePid, held.pid);
      } finally {
        held.release();
        await first;
      }
      const [out] = await Promise.all([first, retype]);
      expect(out.recorded).toBe(true);
      const [row] = await rowsOf(sql`SELECT column_id FROM issue WHERE id = ${s.issueId}`);
      expect(row.column_id).toBe(s.completedColumnId);
    });
  }, 30000);
});
