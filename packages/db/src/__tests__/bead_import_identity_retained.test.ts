import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { type IdentityTransaction } from '../issue-identity';
import { importBeadIdentity } from '../bead-import-identity';
import {
  assertRetainedArtifactUnchanged,
  retainedArtifactOf,
  saveRetainedArtifact,
} from '../../../../apps/worker/src/import-retained';
import type { CanonicalRetainedRow } from '../../../../apps/worker/src/reader';
import { RUN, targetUrl } from './bead-import-target-guard';

// PREPARED, NOT RUN (same guards and target as the identity suite above): the
// independent PostgreSQL rollback witness for the RETAINED pipeline half - the
// tombstone stamp AND the content artifact must commit or roll back together as
// ONE import transaction (Office RETURN3 D3 / Root 2026-11-15). The identity
// suite above proves the ledger half against this database; this suite proves
// the artifact half (import_job.config->'retainedArtifact') on the same real
// driver, so a synthetic fake cannot stand in for the rollback. Its own rig and
// fixture chain: the identity suite's immutable rig and ledger are untouched.
describe('retained tombstones and content artifact: one PostgreSQL transaction (rollback witness)', () => {
  const ART_PREFIX = `imp83631-art-${RUN}`;
  const ART_TOKEN = '9100.1';
  const ART_BODY = 'the memory body this artifact must carry';
  // The retained row this witness proves: one memory row with a body, exactly
  // the shape the worker's recordRetainedRows feeds the hook loop and the
  // digest (retainedArtifactOf, the same function the worker calls).
  const ART_ROW: CanonicalRetainedRow = {
    sourceId: `${ART_PREFIX}-9100.1`,
    title: 'the memory card',
    retention: 'tombstone_identity',
    reason: "bd class 'memory' is a retained non-ticket class",
    unmapped: [
      { field: 'description', value: ART_BODY, note: 'retained non-ticket source content' },
    ],
  };
  const ARTIFACT = retainedArtifactOf([ART_ROW]);
  let client2: postgres.Sql;
  let db2: ReturnType<typeof drizzle>;
  let rigId = 0;
  let projectId = 0;
  let jobId = 0;
  // A SECOND fresh job with no retainedArtifact: the rollback path must be
  // exercised where the F1 guard PASSES (no committed receipt yet), so the
  // writes actually run and the driver's rollback is what undoes them - an
  // abort against the committed job would hit the changed-digest refusal
  // instead (Root literal review round 2, 2026-11-15).
  let abortJobId = 0;
  let userId = '';
  const made = {
    job: false,
    abortJob: false,
    column: [] as number[],
    project: false,
    team: false,
    teamId: 0,
    workspace: false,
    wsId: 0,
    user: false,
  };

  beforeAll(async () => {
    const url = targetUrl(process.env.DATABASE_URL, process.env.NODE_ENV);
    client2 = postgres(url, { max: 1, onnotice: () => undefined });
    db2 = drizzle(client2);
    const [u] = await client2`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES (${`imp83631-${RUN}`}, '8363.1 artifact fixture operator', ${`imp83631-${RUN}@example.invalid`}, true)
      RETURNING id`;
    userId = u.id as string;
    made.user = true;
    const [rig] =
      await client2`INSERT INTO rig (prefix, next_root) VALUES (${ART_PREFIX}, 1) RETURNING id`;
    rigId = rig.id as number;
    const [ws] =
      await client2`INSERT INTO workspace (name) VALUES ('8363.1 artifact ws') RETURNING id`;
    made.wsId = ws.id as number;
    made.workspace = true;
    const [team] = await client2`
      INSERT INTO team (workspace_id, name, slug)
      VALUES (${ws.id}, '8363.1 artifact team', ${`art-${ws.id}`}) RETURNING id`;
    made.teamId = team.id as number;
    made.team = true;
    const [proj] = await client2`
      INSERT INTO project (team_id, key, name)
      VALUES (${team.id}, ${`ART${ws.id}`}, '8363.1 artifact project') RETURNING id`;
    projectId = proj.id as number;
    made.project = true;
    const [job] = await client2`
      INSERT INTO import_job (project_id, created_by_user_id, source)
      VALUES (${projectId}, ${userId}, 'bd') RETURNING id`;
    jobId = job.id as number;
    made.job = true;
    // Same owned project and user; a distinct job row, so the abort path's
    // guard reads a job with NO committed artifact and passes - the writes
    // then run and only the driver's rollback can undo them.
    const [abortJob] = await client2`
      INSERT INTO import_job (project_id, created_by_user_id, source)
      VALUES (${projectId}, ${userId}, 'bd') RETURNING id`;
    abortJobId = abortJob.id as number;
    made.abortJob = true;
  });

  afterAll(async () => {
    // Same discipline as the identity suite: the fixture chain is torn down in
    // foreign-key order (surviving a partial beforeAll); the rig is NEVER
    // deleted, in any outcome - a failed run's rig is preserved and reported.
    const live = client2 as postgres.Sql | undefined;
    if (!live) return;
    if (made.job) await live`DELETE FROM import_job WHERE id = ${jobId}`;
    if (made.abortJob) await live`DELETE FROM import_job WHERE id = ${abortJobId}`;
    for (const id of made.column.splice(0)) await live`DELETE FROM project_column WHERE id = ${id}`;
    if (made.project) await live`DELETE FROM project WHERE id = ${projectId}`;
    if (made.team) await live`DELETE FROM team WHERE id = ${made.teamId}`;
    if (made.workspace) await live`DELETE FROM workspace WHERE id = ${made.wsId}`;
    if (made.user) await live`DELETE FROM "user" WHERE id = ${userId}`;
    await live.end();
  });

  // One transaction, both writes - the exact shape recordRetainedRows now runs
  // (import-worker.ts): the tombstone stamp, then the content artifact, inside
  // the caller's own import transaction.
  async function oneTx(
    token: string,
    abort: boolean,
    opts: { artifact?: typeof ARTIFACT; jobId?: number } = {},
  ): Promise<void> {
    const artifact = opts.artifact ?? ARTIFACT;
    const job = opts.jobId ?? jobId;
    const crash = Symbol('abort the import transaction');
    try {
      await db2.transaction(async (tx) => {
        const t = tx as unknown as IdentityTransaction;
        // The worker's exact retained-TX order (F1): lock the job's own row and
        // check the committed digest FIRST, then stamp, then write the receipt.
        await assertRetainedArtifactUnchanged(t, job, artifact.digest);
        const res = await importBeadIdentity(t, { rigId, localToken: token, issueId: null });
        if (!res.ok) throw new Error(`tombstone refused: ${res.code}`);
        await saveRetainedArtifact(t, job, artifact);
        if (abort) throw crash;
      });
    } catch (error) {
      if (error !== crash) throw error;
    }
  }

  it('commits BOTH: the tombstone ledger row and the content artifact in config', async () => {
    await oneTx(ART_TOKEN, false);
    const [row] = (await client2`
      SELECT local_token, issue_id FROM bead_identity WHERE rig_id = ${rigId}`) as unknown as {
      local_token: string;
      issue_id: number | null;
    }[];
    expect(row.local_token).toBe(ART_TOKEN);
    expect(row.issue_id).toBeNull();
    const [job] = (await client2`
      SELECT config -> 'retainedArtifact' AS art FROM import_job WHERE id = ${jobId}`) as unknown as {
      art: {
        digest: string;
        rows: { unmapped: { field: string; value: string; note: string }[] }[];
      };
    }[];
    expect(job.art).toBeDefined();
    expect(job.art!.digest).toBe(ARTIFACT.digest);
    const body = job.art!.rows[0]!.unmapped.find((u) => u.field === 'description');
    expect(body!.value).toBe(ART_BODY);
  });

  it('rolls back BOTH on a transaction failure: no tombstone row and no artifact receipt', async () => {
    const token = '9100.2';
    // A DISTINCT artifact on a FRESH job (no committed receipt): the F1 guard
    // passes, the stamp and the write actually RUN, and only the driver's
    // rollback can undo them. If the transaction ever escaped to commit, the
    // fresh job would carry this body and this digest - so reading them back
    // afterwards as absent is a real proof of the rollback, not a no-op
    // (Root literal review, round 2: an abort against the already-committed
    // job would hit the changed-digest refusal, which proves the guard, not
    // the rollback).
    const ABORTED_BODY = 'an aborted body that must never land';
    const aborted = retainedArtifactOf([
      {
        ...ART_ROW,
        sourceId: `${ART_PREFIX}-9100.2`,
        unmapped: [
          { field: 'description', value: ABORTED_BODY, note: 'retained non-ticket source content' },
        ],
      },
    ]);
    expect(aborted.digest).not.toBe(ARTIFACT.digest);
    const crash = Symbol('abort the import transaction');
    let insideTxWriteVisible = false;
    try {
      await db2.transaction(async (tx) => {
        const t = tx as unknown as IdentityTransaction;
        await assertRetainedArtifactUnchanged(t, abortJobId, aborted.digest);
        const res = await importBeadIdentity(t, { rigId, localToken: token, issueId: null });
        if (!res.ok) throw new Error(`tombstone refused: ${res.code}`);
        await saveRetainedArtifact(t, abortJobId, aborted);
        // INSIDE the transaction, after the write: the distinct bytes must be
        // visible to this very tx - the write ran; the marker below throws, so
        // only a real rollback can make them disappear.
        const [check] = (await t.execute(
          sql`SELECT config -> 'retainedArtifact' ->> 'digest' AS digest,
                 config -> 'retainedArtifact' -> 'rows' -> 0 -> 'unmapped' -> 0 ->> 'value' AS body
              FROM import_job WHERE id = ${abortJobId}`,
        )) as unknown as { digest: string | null; body: string | null }[];
        insideTxWriteVisible = check.digest === aborted.digest && check.body === ABORTED_BODY;
        if (!insideTxWriteVisible) throw new Error('the write was not visible inside the tx');
        throw crash;
      });
    } catch (error) {
      if (error !== crash) throw error;
    }
    // The write WAS visible inside the tx before the throw - the rollback had
    // to do real work.
    expect(insideTxWriteVisible).toBe(true);
    // The aborted token is gone: the real driver rolled the transaction back.
    const rows = (await client2`
      SELECT local_token FROM bead_identity WHERE rig_id = ${rigId}`) as unknown as {
      local_token: string;
    }[];
    expect(rows.map((r) => r.local_token)).toEqual([ART_TOKEN]);
    // The fresh abort job has NO artifact at all: the distinct body and digest
    // never landed.
    const [fresh] = (await client2`
      SELECT config -> 'retainedArtifact' ->> 'digest' AS digest,
             config -> 'retainedArtifact' -> 'rows' -> 0 -> 'unmapped' -> 0 ->> 'value' AS body
      FROM import_job WHERE id = ${abortJobId}`) as unknown as {
      digest: string | null;
      body: string | null;
    }[];
    expect(fresh.digest).toBeNull();
    expect(fresh.body).toBeNull();
    // And the ORIGINAL committed job still carries the original receipt,
    // byte for byte.
    const [job] = (await client2`
      SELECT config -> 'retainedArtifact' ->> 'digest' AS digest,
             config -> 'retainedArtifact' -> 'rows' -> 0 -> 'unmapped' -> 0 ->> 'value' AS body
      FROM import_job WHERE id = ${jobId}`) as unknown as {
      digest: string | null;
      body: string | null;
    }[];
    expect(job.digest).toBe(ARTIFACT.digest);
    expect(job.body).toBe(ART_BODY);
    expect(job.body).not.toBe(ABORTED_BODY);
  });

  it('replays idempotently: the same committed digest commits again, changing nothing', async () => {
    // The crashed-and-retried tick, happy path: the board is unchanged, so the
    // rebuilt artifact has the SAME committed digest. The real transaction must
    // accept it - the stamp re-runs idempotently and the receipt lands again -
    // and leave the ledger exactly as it was.
    await oneTx(ART_TOKEN, false);
    const rows = (await client2`
      SELECT local_token FROM bead_identity WHERE rig_id = ${rigId}`) as unknown as {
      local_token: string;
    }[];
    expect(rows.map((r) => r.local_token)).toEqual([ART_TOKEN]);
    const [job] = (await client2`
      SELECT config -> 'retainedArtifact' ->> 'digest' AS digest FROM import_job WHERE id = ${jobId}`) as unknown as {
      digest: string | null;
    }[];
    expect(job.digest).toBe(ARTIFACT.digest);
  });

  it('refuses a changed source after the committed step: no new stamp, no replaced receipt', async () => {
    // The retried tick re-reads the board and the source CHANGED: a new row
    // appeared, so the rebuilt artifact's digest differs from the committed
    // receipt. The transaction must refuse at the lock-read - before any stamp
    // or write - and the committed receipt must survive untouched.
    const changed = retainedArtifactOf([
      ART_ROW,
      {
        sourceId: `${ART_PREFIX}-9100.3`,
        title: 'a memory that appeared after the commit',
        retention: 'tombstone_identity',
        reason: 'later',
        unmapped: [],
      },
    ]);
    expect(changed.digest).not.toBe(ARTIFACT.digest);
    await expect(oneTx('9100.3', false, { artifact: changed })).rejects.toThrow(/different digest/);
    // The refusal ran before the stamp: no 9100.3 ledger row exists...
    const rows = (await client2`
      SELECT local_token FROM bead_identity WHERE rig_id = ${rigId}`) as unknown as {
      local_token: string;
    }[];
    expect(rows.map((r) => r.local_token)).toEqual([ART_TOKEN]);
    // ...and the committed receipt was not silently replaced.
    const [job] = (await client2`
      SELECT config -> 'retainedArtifact' ->> 'digest' AS digest FROM import_job WHERE id = ${jobId}`) as unknown as {
      digest: string | null;
    }[];
    expect(job.digest).toBe(ARTIFACT.digest);
  });

  it('refuses a missing job before any stamp: no orphaned rows', async () => {
    // The job row is gone (0 rows at the lock-read): the transaction must refuse
    // before stamping anything, leaving the ledger exactly as it was.
    await expect(oneTx('9100.4', false, { jobId: 999999 })).rejects.toThrow(
      /import job 999999 does not exist/,
    );
    const rows = (await client2`
      SELECT local_token FROM bead_identity WHERE rig_id = ${rigId}`) as unknown as {
      local_token: string;
    }[];
    expect(rows.map((r) => r.local_token)).toEqual([ART_TOKEN]);
  });
});
