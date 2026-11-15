// The retained artifact half of the bd import tests (split out of
// import-sources.test.ts, Root P0 2026-11-15: leaves under the 400-line cap,
// split by actual responsibility, no behavior change - these tests moved
// verbatim). import-sources.test.ts keeps the stamp hooks (issue + tombstone);
// this leaf owns the durable artifact pipeline (Office RETURN3 D3 / F1 / F3):
//
//   - the tombstone stamp and the artifact write land on the SAME transaction
//     (a crash rolls both back; the in-tx write visibility is proven before
//     the forced crash);
//   - F1: a changed source after the committed step refuses BEFORE any stamp
//     or write; a missing job refuses; the same digest replays idempotently;
//   - F3: a vanished job makes the receipt write throw inside the
//     transaction; an EMPTY retained list still runs the guard;
//   - the digest is over the canonical order and a changed row changes it.
//
// The fake transaction and rig fixtures are the same ones the hook file uses
// (duplicated per leaf - test fixtures, not a shim chain).
import { describe, expect, test } from 'bun:test';
import { RETAINED_CONTENT_NOTE } from './bd-adapter';
import type { CanonicalRetainedRow } from './reader';
import { afterIssueCreatedForJob, afterRetainedRowForJob } from './import-sources';
import {
  assertRetainedArtifactUnchanged,
  retainedArtifactOf,
  saveRetainedArtifact,
} from './import-retained';

interface FakeTx {
  execute(q: { toQuery?: (c: object) => { sql: string } }): Promise<unknown[]>;
  transaction<R>(fn: (sp: FakeTx) => Promise<R>): Promise<R>;
}

function fakeTx(patterns: [RegExp, unknown[]][], log: string[]): FakeTx {
  const answer = (q: FakeTx['execute'] extends (q: infer Q) => unknown ? Q : never) => {
    // Render the bound values where drizzle can; its inlineParams mode cannot render
    // a NULL literal, so those statements fall back to a dump of the bound chunk
    // values - the values are still visible for the assertions.
    const rendered = q as {
      toQuery?: (c: object) => { sql: string };
      queryChunks?: { value?: unknown }[];
    };
    let text: string;
    try {
      text = rendered.toQuery?.({ inlineParams: true })?.sql ?? String(q);
    } catch {
      const chunks = (rendered.queryChunks ?? []) as unknown[];
      text = chunks
        .map((c) => {
          if (c == null) return '? null';
          const v = (c as { value?: unknown }).value;
          if (Array.isArray(v)) return v.join('');
          if (typeof v === 'string') return v;
          return `? ${JSON.stringify(c)}`;
        })
        .join(' ');
    }
    log.push(text);
    for (const [re, rows] of patterns) if (re.test(text)) return Promise.resolve(rows);
    return Promise.resolve([]);
  };
  return {
    execute: answer,
    transaction: (fn) => fn(fakeTx(patterns, log)),
  };
}

type HookTx = Parameters<NonNullable<ReturnType<typeof afterIssueCreatedForJob>>>[0];
const asHookTx = (tx: FakeTx) => tx as unknown as HookTx;

const RIG = /SELECT prefix, next_root FROM rig/i;
const HIGHEST = /AS highest/i;
const PROJECT = /SELECT p\.rig_id, r\.prefix FROM project/i;
// F1: the retained transaction's first act locks the job's own row and reads the
// committed digest (0 rows = the job is gone; null = no artifact yet). The
// statement renders inline in the fake, so the keyword pattern is stable.
const JOB_ARTIFACT = /digest'\) AS digest\s+FROM import_job/i;
// The real shape (Office RETURN3 D1): the rig is 'sentinel-prod' and the card id is
// '<rig>-<token>'. The ledger holds the token; the writer's re-prefix restores the
// full bd id as the bead id.
const PREFIX = 'sentinel-prod';
const RIG_ROW = { rig_id: 7, prefix: PREFIX };
const RIG_LOCK = { prefix: PREFIX, next_root: 10 };

describe('the retained artifact commits with its tombstones (Office RETURN3 D3)', () => {
  // The RETURN3 defect: the worker committed the tombstone transaction and then
  // wrote the content artifact on the GLOBAL db in a separate statement, so a
  // crash in between left committed tombstones with no durable receipt. The fix
  // puts both writes on the caller's import transaction; this proof watches both
  // land on one transaction. (The real PostgreSQL rollback witness stays in the
  // prepared DB suite for Root's serial slot - a synthetic tx cannot witness a
  // driver rollback itself.)
  const ROW: CanonicalRetainedRow = {
    sourceId: `${PREFIX}-9010.2`,
    title: 'retained memory',
    retention: 'tombstone_identity',
    reason: "bd class 'memory' is a retained non-ticket class",
    unmapped: [{ field: 'description', value: 'memory body', note: RETAINED_CONTENT_NOTE }],
  };
  const ARTIFACT = retainedArtifactOf([ROW]);

  test('the tombstone stamp and the artifact write land on the SAME transaction', async () => {
    const hook = afterRetainedRowForJob({ id: 9, source: 'bd', config: {} });
    const log: string[] = [];
    const tx = fakeTx(
      [
        [PROJECT, [RIG_ROW]],
        [RIG, [RIG_LOCK]],
        [HIGHEST, [{ highest: 42 }]],
        // F1/F3: the lock-read sees the job with no committed artifact yet, and
        // the receipt's UPDATE lands exactly one row (RETURNING id).
        [JOB_ARTIFACT, [{ digest: null }]],
        [/UPDATE import_job/i, [{ id: 9 }]],
      ],
      log,
    );
    // One tx stands in for the import transaction: everything it records is what
    // the single commit carries. The worker's order: lock the job and check the
    // committed digest FIRST, then stamp, then write the receipt.
    await assertRetainedArtifactUnchanged(asHookTx(tx), 9, ARTIFACT.digest);
    await hook!(asHookTx(tx), { jobId: 9, sourceId: ROW.sourceId, projectId: 3, row: ROW });
    await saveRetainedArtifact(asHookTx(tx), 9, ARTIFACT);

    const lock = log.find((s) => /FOR UPDATE/i.test(s));
    const tombstone = log.find((s) => /INSERT INTO bead_identity/i.test(s));
    const artifact = log.find((s) => /UPDATE import_job/i.test(s));
    expect(lock).toBeDefined();
    expect(tombstone).toBeDefined();
    expect(artifact).toBeDefined();
    // The receipt is durable content, not a pointer: the reserved key, the
    // digest and the body bytes are all in the statement.
    expect(artifact).toContain('retainedArtifact');
    expect(artifact).toContain(ARTIFACT.digest);
    expect(artifact).toContain('memory body');
    expect(artifact).toContain('9010.2');
    // The lock precedes the stamp, the receipt lands AFTER the stamp it
    // certifies - and everything is on this same tx, so the one commit covers
    // all of it.
    expect(log.indexOf(lock!)).toBeLessThan(log.indexOf(tombstone!));
    expect(log.indexOf(tombstone!)).toBeLessThan(log.indexOf(artifact!));
  });

  test('a changed source after the committed step refuses BEFORE any stamp or write', async () => {
    // The committed receipt has a different digest: the board changed (or a row
    // was removed) between the committed step and this retried tick. The
    // transaction must refuse at the lock-read, before the hook ever runs.
    const hook = afterRetainedRowForJob({ id: 9, source: 'bd', config: {} });
    const log: string[] = [];
    const OTHER = 'ffff'.repeat(16);
    const tx = fakeTx([[JOB_ARTIFACT, [{ digest: OTHER }]]], log);
    await expect(
      (async () => {
        await assertRetainedArtifactUnchanged(asHookTx(tx), 9, ARTIFACT.digest);
        await hook!(asHookTx(tx), { jobId: 9, sourceId: ROW.sourceId, projectId: 3, row: ROW });
        await saveRetainedArtifact(asHookTx(tx), 9, ARTIFACT);
      })(),
    ).rejects.toThrow(/different digest/);
    // The refusal ran before anything else: no rig lookup, no stamp, no write -
    // the committed receipt is never silently replaced.
    expect(log).toHaveLength(1);
    expect(log[0]!).toContain('FOR UPDATE');
    expect(log.some((s) => /INSERT INTO bead_identity/i.test(s))).toBe(false);
    expect(log.some((s) => /UPDATE import_job/i.test(s))).toBe(false);
  });

  test('a missing job refuses before any stamp or write', async () => {
    const hook = afterRetainedRowForJob({ id: 9, source: 'bd', config: {} });
    const log: string[] = [];
    const tx = fakeTx([[JOB_ARTIFACT, []]], log);
    await expect(
      (async () => {
        await assertRetainedArtifactUnchanged(asHookTx(tx), 9, ARTIFACT.digest);
        await hook!(asHookTx(tx), { jobId: 9, sourceId: ROW.sourceId, projectId: 3, row: ROW });
        await saveRetainedArtifact(asHookTx(tx), 9, ARTIFACT);
      })(),
    ).rejects.toThrow(/import job 9 does not exist/);
    expect(log).toHaveLength(1);
    expect(log.some((s) => /INSERT INTO bead_identity/i.test(s))).toBe(false);
  });

  test('the same committed digest passes: the idempotent replay', async () => {
    const log: string[] = [];
    const tx = fakeTx([[JOB_ARTIFACT, [{ digest: ARTIFACT.digest }]]], log);
    await expect(
      assertRetainedArtifactUnchanged(asHookTx(tx), 9, ARTIFACT.digest),
    ).resolves.toBeUndefined();
    // Only the lock-read ran: a matching committed receipt is the idempotent
    // replay, not a refusal.
    expect(log).toHaveLength(1);
  });

  test('a vanished job makes the receipt write throw inside the transaction', async () => {
    // F3: the UPDATE carries RETURNING id; zero rows means the job is gone and
    // the throw rolls the transaction back with the stamps (no orphaned stamps).
    const log: string[] = [];
    const tx = fakeTx([[/UPDATE import_job/i, []]], log);
    await expect(saveRetainedArtifact(asHookTx(tx), 9, ARTIFACT)).rejects.toThrow(
      /expected exactly one import_job row, got 0/,
    );
    expect(log).toHaveLength(1);
  });

  test('an EMPTY retained list still runs the guard: the whole set removed after the commit refuses (CT fix 2)', async () => {
    // The worker's recordRetainedRows no longer early-returns on zero rows:
    // retainedArtifactOf([]) digests the empty canonical form, and the SAME
    // guard path runs. A committed receipt over the removed rows has a
    // different digest than the empty set - so the refusal fires instead of a
    // silent skip, and the committed receipt survives untouched.
    const EMPTY = retainedArtifactOf([]);
    expect(EMPTY.digest).not.toBe(ARTIFACT.digest);
    const hook = afterRetainedRowForJob({ id: 9, source: 'bd', config: {} });
    const log: string[] = [];
    const tx = fakeTx([[JOB_ARTIFACT, [{ digest: ARTIFACT.digest }]]], log);
    await expect(
      (async () => {
        // The worker's exact sequence with zero rows: guard first, empty stamp
        // loop, then the (never reached) write.
        await assertRetainedArtifactUnchanged(asHookTx(tx), 9, EMPTY.digest);
        for (const row of [] as CanonicalRetainedRow[]) {
          await hook!(asHookTx(tx), { jobId: 9, sourceId: row.sourceId, projectId: 3, row });
        }
        await saveRetainedArtifact(asHookTx(tx), 9, EMPTY);
      })(),
    ).rejects.toThrow(/different digest/);
    // Only the lock-read ran: no stamps for a vanished row, no replaced receipt.
    expect(log).toHaveLength(1);
    expect(log.some((s) => /INSERT INTO bead_identity/i.test(s))).toBe(false);
    expect(log.some((s) => /UPDATE import_job/i.test(s))).toBe(false);
  });

  test('an EMPTY retained list with no committed receipt commits the empty receipt (first run, then rows removed later)', async () => {
    // The other side of the same fix: a job that has never committed a receipt
    // accepts the empty set (guard passes: no committed digest yet), and a LATER
    // tick where rows reappear is refused by the changed digest - both
    // directions go through the same path.
    const EMPTY = retainedArtifactOf([]);
    const log: string[] = [];
    const tx = fakeTx(
      [
        [JOB_ARTIFACT, [{ digest: null }]],
        [/UPDATE import_job/i, [{ id: 9 }]],
      ],
      log,
    );
    await assertRetainedArtifactUnchanged(asHookTx(tx), 9, EMPTY.digest);
    await saveRetainedArtifact(asHookTx(tx), 9, EMPTY);
    expect(log.some((s) => /UPDATE import_job/i.test(s))).toBe(true);
    expect(log.some((s) => /INSERT INTO bead_identity/i.test(s))).toBe(false);
  });

  test('a failure inside the transaction body propagates: both writes roll back together', async () => {
    const hook = afterRetainedRowForJob({ id: 9, source: 'bd', config: {} });
    const log: string[] = [];
    const tx = fakeTx(
      [
        [PROJECT, [RIG_ROW]],
        [RIG, [RIG_LOCK]],
        [HIGHEST, [{ highest: 42 }]],
        [JOB_ARTIFACT, [{ digest: null }]],
        [/UPDATE import_job/i, [{ id: 9 }]],
      ],
      log,
    );
    const crash = Symbol('crash after both writes');
    let thrown: unknown = null;
    try {
      await (async () => {
        await assertRetainedArtifactUnchanged(asHookTx(tx), 9, ARTIFACT.digest);
        await hook!(asHookTx(tx), { jobId: 9, sourceId: ROW.sourceId, projectId: 3, row: ROW });
        await saveRetainedArtifact(asHookTx(tx), 9, ARTIFACT);
        throw crash;
      })();
    } catch (error) {
      thrown = error;
    }
    // The throw escaped the tx body - the driver rolls the transaction back and
    // undoes BOTH writes (the synthetic witness: both statements are inside the
    // body that failed; nothing after it ran).
    expect(thrown).toBe(crash);
    expect(log.some((s) => /INSERT INTO bead_identity/i.test(s))).toBe(true);
    // The receipt is the transaction's LAST recorded act before the failure:
    // nothing ran after it, so the driver's rollback of this body undoes the
    // stamp AND the receipt together.
    expect(log.findIndex((s) => /UPDATE import_job/i.test(s))).toBe(log.length - 1);
  });
});

describe('the retained artifact digest', () => {
  const A = {
    sourceId: 'b',
    title: 't',
    retention: 'tombstone_identity',
    reason: 'r',
    unmapped: [{ field: 'assignee', value: 'qwen', note: 'n' }],
  };
  const B = {
    sourceId: 'a',
    title: 'u',
    retention: 'tombstone_identity',
    reason: 's',
    unmapped: [],
  };

  test('the digest is over the canonical order: input order does not matter', () => {
    expect(retainedArtifactOf([A, B]).digest).toBe(retainedArtifactOf([B, A]).digest);
  });

  test('the artifact sorts the rows and a changed row changes the digest', () => {
    const artifact = retainedArtifactOf([A, B]);
    expect(artifact.rows.map((r) => r.sourceId)).toEqual(['a', 'b']);
    expect(artifact.digest).toHaveLength(64);
    expect(retainedArtifactOf([{ ...A, title: 'changed' }, B]).digest).not.toBe(artifact.digest);
  });
});
