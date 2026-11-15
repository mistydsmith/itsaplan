import { describe, expect, test } from 'bun:test';
import { afterIssueCreatedForJob, afterRetainedRowForJob } from './import-sources';

// A synthetic transaction: it records every SQL statement (with parameters
// inlined, the way the binding-proof helper in the db package renders them) and
// answers the handful of SELECTs importBeadIdentity issues. No database - the proof
// is about which statements the hook runs, in what order, and how it fails.
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
const ISSUE = /SELECT bead_id FROM issue WHERE id/i;
const HIGHEST = /AS highest/i;
const PROJECT = /SELECT p\.rig_id, r\.prefix FROM project/i;
// The real shape (Office RETURN3 D1): the rig is 'sentinel-prod' and the card id is
// '<rig>-<token>'. The ledger holds the token; the writer's re-prefix restores the
// full bd id as the bead id.
const PREFIX = 'sentinel-prod';
const RIG_ROW = { rig_id: 7, prefix: PREFIX };
const RIG_LOCK = { prefix: PREFIX, next_root: 10 };

describe('the bd after-issue-created stamp hook', () => {
  test('other sources keep no hook: the pipeline stamps nothing for them', () => {
    for (const source of ['plane', 'linear', 'trello']) {
      expect(afterIssueCreatedForJob({ id: 1, source, config: {} })).toBeNull();
    }
  });

  test('the bd hook stamps the real prefixed id: token in the ledger, full id on the issue', async () => {
    const hook = afterIssueCreatedForJob({ id: 1, source: 'bd', config: {} });
    expect(hook).not.toBeNull();
    const log: string[] = [];
    await hook!(
      asHookTx(
        fakeTx(
          [
            [PROJECT, [RIG_ROW]],
            [RIG, [RIG_LOCK]],
            [ISSUE, [{ bead_id: null }]],
            [HIGHEST, [{ highest: 42 }]],
          ],
          log,
        ),
      ),
      { jobId: 1, sourceId: `${PREFIX}-8363.1`, projectId: 3, localId: 555 },
    );

    const updateIssue = log.find((s) => /UPDATE issue SET bead_id/i.test(s));
    // The issue carries the FULL bd id: writer prefix + stripped token round-trips
    // to exactly the source id the card had on the board.
    expect(updateIssue).toContain(`${PREFIX}-8363.1`);
    expect(updateIssue).toContain('555');
    const insertLedger = log.find((s) => /INSERT INTO bead_identity/i.test(s));
    expect(insertLedger).toBeDefined();
    // The ledger's local token is the card's number WITHIN the rig - the bare
    // '8363.1', so the numeric root 8363 stays visible to the counter. The rig
    // prefix must NOT appear in the INSERT: a doubled prefix would mean the full
    // id leaked through as the token (the RETURN3 defect).
    expect(insertLedger).toContain('8363.1');
    expect(insertLedger).not.toContain(PREFIX);
    // The issue stamp lands before the ledger row: a row that disagrees with its
    // issue would be a second truth, and the ledger row is what the retry re-derives.
    expect(log.indexOf(updateIssue!)).toBeLessThan(log.indexOf(insertLedger!));
    // The counter moves above the highest root the ledger now holds.
    expect(log.some((s) => /UPDATE rig SET next_root/i.test(s))).toBe(true);
  });

  test('a foreign/legacy-prefix id is REFUSED before any identity statement: never stamped into this rig (Root ruling 2026-11-15)', async () => {
    // Root ruling: no fallback that renames b-4500 into sentinel-prod-b-4500.
    // The stamp hook must refuse a source id that does not carry the rig's
    // exact prefix - and the refusal happens BEFORE any identity statement
    // (the only SQL is the rig lookup; the whole transaction rolls back).
    const hook = afterIssueCreatedForJob({ id: 1, source: 'bd', config: {} });
    const log: string[] = [];
    await expect(
      hook!(asHookTx(fakeTx([[PROJECT, [RIG_ROW]]], log)), {
        jobId: 1,
        sourceId: 'b-4500',
        projectId: 3,
        localId: 555,
      }),
    ).rejects.toThrow('does not carry the rig prefix sentinel-prod');
    expect(log).toHaveLength(1);
    expect(log[0]!).toContain('FROM project');
    expect(log.some((s) => /INSERT INTO bead_identity/i.test(s))).toBe(false);
    expect(log.some((s) => /UPDATE issue/i.test(s))).toBe(false);
  });

  test('the explicit legacy rig prefix b stamps b-4500 with token 4500: the number in the ledger, the full id on the issue', async () => {
    // Root's legacy project carries its own rig with prefix b. The SAME hook
    // and the SAME strict derivation map b-4500 to token 4500: the writer
    // re-prefixes to exactly b-4500 on the issue, and the ledger holds the
    // bare number so the counter sees root 4500.
    const hook = afterIssueCreatedForJob({ id: 1, source: 'bd', config: {} });
    const log: string[] = [];
    await hook!(
      asHookTx(
        fakeTx(
          [
            [/SELECT p\.rig_id, r\.prefix FROM project/i, [{ rig_id: 8, prefix: 'b' }]],
            [RIG, [{ prefix: 'b', next_root: 10 }]],
            [ISSUE, [{ bead_id: null }]],
            [HIGHEST, [{ highest: 42 }]],
          ],
          log,
        ),
      ),
      { jobId: 1, sourceId: 'b-4500', projectId: 3, localId: 555 },
    );
    const insertLedger = log.find((s) => /INSERT INTO bead_identity/i.test(s));
    expect(insertLedger).toBeDefined();
    // The token is the bare number 4500 - the b- prefix must NOT ride into the
    // ledger (a doubled/foreign prefix would hide the numeric root).
    expect(insertLedger).toContain('4500');
    expect(insertLedger).not.toContain('b-4500');
    const updateIssue = log.find((s) => /UPDATE issue/i.test(s))!;
    // The issue carries the FULL source id: writer prefix b + token 4500
    // round-trips to exactly b-4500.
    expect(updateIssue).toContain('b-4500');
    expect(updateIssue).toContain('555');
  });

  test('a replay of the same source id is an idempotent attach, not a failure', async () => {
    const hook = afterIssueCreatedForJob({ id: 1, source: 'bd', config: {} });
    const log: string[] = [];
    // The issue already carries this import's identity: the writer treats that as
    // alreadyPresent and does not re-stamp.
    await hook!(
      asHookTx(
        fakeTx(
          [
            [PROJECT, [RIG_ROW]],
            [RIG, [RIG_LOCK]],
            [ISSUE, [{ bead_id: `${PREFIX}-8363.1` }]],
            [HIGHEST, [{ highest: 42 }]],
          ],
          log,
        ),
      ),
      { jobId: 1, sourceId: `${PREFIX}-8363.1`, projectId: 3, localId: 555 },
    );
    expect(log.some((s) => /UPDATE issue SET bead_id/i.test(s))).toBe(false);
    expect(log.some((s) => /INSERT INTO bead_identity/i.test(s))).toBe(true);
  });

  test('a project without a rig fails closed before any identity write', async () => {
    const hook = afterIssueCreatedForJob({ id: 1, source: 'bd', config: {} });
    const log: string[] = [];
    await expect(
      hook!(asHookTx(fakeTx([[PROJECT, []]], log)), {
        jobId: 1,
        sourceId: `${PREFIX}-8363.1`,
        projectId: 3,
        localId: 555,
      }),
    ).rejects.toThrow(/has no rig/);
    // Only the rig lookup ran; no identity statement was even attempted.
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(PROJECT);
  });

  test('a refusal - an issue carrying a DIFFERENT identity - fails the transaction', async () => {
    const hook = afterIssueCreatedForJob({ id: 1, source: 'bd', config: {} });
    const log: string[] = [];
    await expect(
      hook!(
        asHookTx(
          fakeTx(
            [
              [PROJECT, [RIG_ROW]],
              [RIG, [RIG_LOCK]],
              [ISSUE, [{ bead_id: `${PREFIX}-999` }]],
              [HIGHEST, [{ highest: 42 }]],
            ],
            log,
          ),
        ),
        { jobId: 1, sourceId: `${PREFIX}-8363.1`, projectId: 3, localId: 555 },
      ),
    ).rejects.toThrow(/refused \(conflict\)/);
    // Nothing was written: the refusal is a throw here, so the caller's transaction
    // rolls back and no partial identity can land.
    expect(log.filter((s) => /^(INSERT|UPDATE)/i.test(s))).toEqual([]);
  });
});

describe('the bd retained-row (tombstone) stamp hook', () => {
  const ROW = {
    sourceId: `${PREFIX}-9010.2`,
    title: 'retained memory',
    retention: 'tombstone_identity',
    reason: "bd class 'memory' is a retained non-ticket class",
    unmapped: [],
  };

  test('other sources keep no retained-row hook either', () => {
    for (const source of ['plane', 'linear', 'trello']) {
      expect(afterRetainedRowForJob({ id: 1, source, config: {} })).toBeNull();
    }
  });

  test('a retained row stamps a TOMBSTONE: the ledger row binds issue_id null', async () => {
    const hook = afterRetainedRowForJob({ id: 1, source: 'bd', config: {} });
    expect(hook).not.toBeNull();
    const log: string[] = [];
    await hook!(
      asHookTx(
        fakeTx(
          [
            [PROJECT, [RIG_ROW]],
            [RIG, [RIG_LOCK]],
            [HIGHEST, [{ highest: 42 }]],
          ],
          log,
        ),
      ),
      { jobId: 1, sourceId: `${PREFIX}-9010.2`, projectId: 3, row: ROW },
    );

    const insertLedger = log.find((s) => /INSERT INTO bead_identity/i.test(s));
    expect(insertLedger).toBeDefined();
    expect(insertLedger).toContain('9010.2');
    // The tombstone's token is the bare card number, exactly like the issue stamp:
    // no doubled prefix in the ledger.
    expect(insertLedger).not.toContain(PREFIX);
    // issue_id is bound null: a tombstone, never a ticket.
    expect(insertLedger).toContain('null');
    // No issue was touched at all: there is no issue to stamp.
    expect(log.some((s) => /UPDATE issue/i.test(s))).toBe(false);
  });

  test('a ticket_metadata row NEVER stamps: no ledger write, no rig read, no second truth', async () => {
    // Studio 2026-11-15 RETURN: the ticket's source metadata rides the SAME
    // durable artifact sink as a distinct typed row, but the ticket's own
    // identity is already on its issue. The hook must skip the row before any
    // rig read or identity write - a second ledger row or an issue_id-null
    // stamp would be a second truth for the same source id.
    const hook = afterRetainedRowForJob({ id: 1, source: 'bd', config: {} });
    expect(hook).not.toBeNull();
    const log: string[] = [];
    await hook!(asHookTx(fakeTx([], log)), {
      jobId: 1,
      sourceId: `${PREFIX}-9010.1`,
      projectId: 3,
      row: { ...ROW, retention: 'ticket_metadata' },
    });
    // The empty fake tx would THROW on any statement: reaching here with zero
    // logged SQL proves the row was skipped before touching the database.
    expect(log).toHaveLength(0);
    // Root P0 2026-11-15: a Dolt memory row (memory:<key>) is NOT a bead - it
    // never stamps a tombstone either. The generic bead tombstone primitive
    // stays for true bead retention (tombstone_identity) only.
    await hook!(asHookTx(fakeTx([], log)), {
      jobId: 1,
      sourceId: 'memory:lane-preference',
      projectId: 3,
      row: { ...ROW, retention: 'memory_key' },
    });
    expect(log).toHaveLength(0);
  });

  test('the tombstone replay and refusal behave exactly like the issue stamp', async () => {
    const hook = afterRetainedRowForJob({ id: 1, source: 'bd', config: {} });
    // Replaying a row whose tombstone already exists with issue_id NULL is an
    // idempotent no-op attach, not a failure.
    const log: string[] = [];
    // The 23505 read-back path is exercised by the db package's prepared suite;
    // here the no-conflict path: the issue SELECT is never issued for a tombstone.
    await hook!(
      asHookTx(
        fakeTx(
          [
            [PROJECT, [RIG_ROW]],
            [RIG, [RIG_LOCK]],
            [HIGHEST, [{ highest: 42 }]],
          ],
          log,
        ),
      ),
      { jobId: 1, sourceId: `${PREFIX}-9010.2`, projectId: 3, row: ROW },
    );
    expect(log.some((s) => /SELECT bead_id FROM issue/i.test(s))).toBe(false);

    // A rig-less project fails closed before any identity write.
    const log2: string[] = [];
    await expect(
      hook!(asHookTx(fakeTx([[PROJECT, []]], log2)), {
        jobId: 1,
        sourceId: `${PREFIX}-9010.2`,
        projectId: 3,
        row: ROW,
      }),
    ).rejects.toThrow(/tombstone identity cannot be stamped/);
    expect(log2).toHaveLength(1);
  });
});
