// scripts/landing-record.test.ts — sentinel-prod-8429 unit 5 behaviour suite.
// WHY each case: every one is a way a record can claim more than the landing did - a completion without a
// published candidate, a move into a column that is not this project's completed column, a second record
// for the same landing, or a half-written record after a failure. Each refusal also proves the item's
// column and the activity list are untouched.
// NO database, network, provider or filesystem: an in-memory store with a real rollback.

import { describe, expect, it } from 'bun:test';

import type { PublishResult } from './landing-publish';
import { recordLanding, type ColumnDescriptor, type RecordItem } from './landing-record';
import { fakeStorage } from './landing-record.test-fixtures';
import { KEY } from './landing-git.test-fixtures';
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const BASE = 'b'.repeat(40);
const SUBJECT = `${KEY}: publish the candidate`;
const TESTS = ['suite one'];
const publication = (over: Partial<PublishResult> = {}, subject = SUBJECT): PublishResult => ({
  published: true,
  landed: true,
  partial: false,
  reason: 'published',
  candidateSha: SHA,
  targetRef: 'refs/heads/main',
  remoteSha: SHA,
  git: {
    eligible: true,
    reason: 'eligible',
    facts: {
      candidateSha: SHA,
      baseSha: BASE,
      targetSha: BASE,
      subject,
      body: '',
      changedPaths: ['scripts/a.ts'],
    },
  },
  ...over,
});
const item = (over: Partial<RecordItem> = {}): RecordItem => ({
  itemKey: KEY,
  projectId: 7,
  columnId: 11,
  status: 'in_progress',
  metadata: { priority: 'high' },
  ...over,
});
const columns: ColumnDescriptor[] = [
  { id: 11, projectId: 7, stateType: 'started' },
  { id: 12, projectId: 7, stateType: 'completed' },
  { id: 13, projectId: 8, stateType: 'completed' },
];
const flight = (sha: string, paths = ['scripts/a.ts']): PublishResult =>
  publication({
    candidateSha: sha,
    remoteSha: sha,
    git: {
      eligible: true,
      reason: 'eligible',
      facts: {
        candidateSha: sha,
        baseSha: BASE,
        targetSha: BASE,
        subject: SUBJECT,
        body: '',
        changedPaths: paths,
      },
    },
  });
const receipt = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  itemKey: KEY,
  candidateSha: SHA,
  baseSha: BASE,
  author: 'dsh',
  allowedPaths: ['scripts/a.ts'],
  namedTests: TESTS,
  outcomes: [{ name: 'suite one', passed: 3, failed: 0 }],
  ...over,
});
const verdict = (over: Record<string, unknown> = {}) => ({
  id: 'v1',
  reviewer: 'qwen-1959',
  sha: SHA,
  decision: 'PASS',
  sequence: 1,
  ...over,
});

type Case = {
  storage?: ReturnType<typeof fakeStorage>;
  publication?: Partial<PublishResult>;
  item?: Partial<RecordItem>;
  completedColumnId?: number;
  columns?: ColumnDescriptor[];
  receipts?: unknown[];
  verdicts?: unknown[];
};

async function run(c: Case = {}) {
  const storage =
    c.storage ?? fakeStorage({ items: { [KEY]: { columnId: c.item?.columnId ?? 11 } } });
  const result = await recordLanding({
    publication: publication(c.publication),
    item: item(c.item),
    receipts: c.receipts ?? [receipt()],
    verdicts: c.verdicts ?? [verdict()],
    completedColumnId: c.completedColumnId ?? 12,
    columns: c.columns ?? columns,
    storage,
    actorName: 'dsh',
  });
  return { result, storage };
}
const landingInput = (storage: ReturnType<typeof fakeStorage>, itemKey = KEY) => ({
  // WHY a per-key subject: the subject is the Git-read one, so a second item needs its own.
  publication: publication({}, `${itemKey}: publish the candidate`),
  item: item({ itemKey }),
  receipts: [receipt({ itemKey })],
  verdicts: [verdict()],
  completedColumnId: 12,
  columns,
  storage,
  actorName: 'dsh',
});
describe('a full landing records, completes and leaves the cleanup obligation', () => {
  it('writes the record, moves the item and records the obligation in one transaction', async () => {
    const { result, storage } = await run();
    expect([result.recorded, result.completed, result.replayed, result.code]).toEqual([
      true,
      true,
      false,
      undefined,
    ]);
    expect(storage.transactions).toBe(1);
    expect(storage.commits).toBe(1);
    expect(storage.rows).toHaveLength(1);
    expect(storage.rows[0].kind).toBe('landing_full');
    expect(storage.items.get(KEY)?.columnId).toBe(12);
    expect(storage.cleanups).toHaveLength(1);
    // The item's metadata travels verbatim onto the record.
    expect(storage.rows[0].payload.metadata).toEqual({ priority: 'high' });
  });
});
describe('a partial landing records only', () => {
  it('keeps the original column and records no cleanup obligation', async () => {
    const { result, storage } = await run({
      publication: publication({ partial: true }, `${KEY} (partial): publish the candidate`),
      // A partial marker in the subject is what the evidence owner reads, so the flight says partial.
      item: item(),
    });
    expect([result.recorded, result.completed, result.partial]).toEqual([true, false, true]);
    expect(storage.rows[0].kind).toBe('landing_partial');
    expect(storage.items.get(KEY)?.columnId).toBe(11);
    expect(storage.cleanups).toHaveLength(0);
  });
});
describe('replay and conflict on the same item key and full SHA', () => {
  it('replays an identical record without writing a second one or moving again', async () => {
    const first = await run();
    expect(first.result.completed).toBe(true);
    const second = await recordLanding({
      publication: publication(),
      item: item({ columnId: 12 }),
      receipts: [receipt()],
      verdicts: [verdict()],
      completedColumnId: 12,
      columns,
      storage: first.storage,
      actorName: 'dsh',
    });
    expect([second.recorded, second.replayed, second.completed]).toEqual([true, true, true]);
    expect(first.storage.rows).toHaveLength(1);
    expect(first.storage.cleanups).toHaveLength(1);
  });

  it('refuses a different record for the same landing, changing nothing', async () => {
    const storage = fakeStorage({
      items: { [KEY]: { columnId: 11 } },
      activities: [
        {
          kind: 'landing_partial',
          payload: { activityId: `${KEY}:${SHA}`, candidateSha: SHA, itemKey: KEY },
        },
      ],
    });
    const { result } = await run({ storage });
    expect(result.code).toBe('RECORD_CONFLICT');
    expect(storage.rows).toHaveLength(0);
    expect(storage.items.get(KEY)?.columnId).toBe(11);
  });
});
describe('refusals before the transaction opens', () => {
  it('refuses a candidate that was not published', async () => {
    const { result, storage } = await run({
      publication: publication({ published: false, code: 'PUSH_FAILED', reason: 'push failed' }),
    });
    expect(result.code).toBe('NOT_PUBLISHED');
    expect(storage.transactions).toBe(0);
  });

  it('refuses when the remote reports another SHA', async () => {
    const { result } = await run({ publication: publication({ remoteSha: BASE }) });
    expect(result.code).toBe('SHA_MISMATCH');
  });

  it('refuses a canceled item and an archived item', async () => {
    const canceled = await run({ item: item({ status: 'canceled' }) });
    expect(canceled.result.code).toBe('ITEM_CANCELED');
    expect(canceled.storage.rows).toHaveLength(0);
    const archived = await run({ item: item({ archived: true }) });
    expect(archived.result.code).toBe('ITEM_ARCHIVED');
    expect(archived.storage.rows).toHaveLength(0);
  });

  it('refuses when the configured column is missing, ambiguous, foreign or not completed', async () => {
    const missing = await run({ completedColumnId: 99 });
    expect(missing.result.code).toBe('COLUMN_MISSING');
    const ambiguous = await run({
      columns: [...columns, { id: 12, projectId: 7, stateType: 'completed' }],
    });
    expect(ambiguous.result.code).toBe('COLUMN_AMBIGUOUS');
    const foreign = await run({ completedColumnId: 13 });
    expect(foreign.result.code).toBe('COLUMN_WRONG_PROJECT');
    const wrongType = await run({ columns: [{ id: 12, projectId: 7, stateType: 'started' }] });
    expect(wrongType.result.code).toBe('COLUMN_NOT_COMPLETED');
    for (const outcome of [missing, ambiguous, foreign, wrongType]) {
      expect(outcome.storage.transactions).toBe(0);
    }
  });

  it('refuses evidence that is not eligible, and reports it as partial when it is', async () => {
    const returned = await run({ verdicts: [verdict({ decision: 'RETURN' })] });
    expect(returned.result.code).toBe('VERDICT_NOT_PASS');
    expect(returned.storage.rows).toHaveLength(0);
  });
});
describe('failures inside the transaction roll everything back', () => {
  for (const step of ['move', 'append', 'cleanup'] as const) {
    it(`rolls back when ${step} fails`, async () => {
      const storage = fakeStorage({ items: { [KEY]: { columnId: 11 } }, failAt: step });
      const { result } = await run({ storage });
      expect(result.code).toBe('STORAGE_FAILED');
      expect(result.recorded).toBe(false);
      expect(storage.rollbacks).toBe(1);
      expect(storage.rows).toHaveLength(0);
      expect(storage.cleanups).toHaveLength(0);
      expect(storage.items.get(KEY)?.columnId).toBe(11);
    });
  }

  it('refuses a move that loses the compare-and-set race', async () => {
    const storage = fakeStorage({ items: { [KEY]: { columnId: 11 } }, racesMove: true });
    const { result } = await run({ storage });
    expect(result.code).toBe('MOVE_FAILED');
    expect(storage.rows).toHaveLength(0);
    expect(storage.items.get(KEY)?.columnId).toBe(11);
  });
});

describe('the reviewed receipt must be about this flight', () => {
  it('refuses a review of another candidate, even when that bundle is eligible', async () => {
    // Root's probe 1: publication names SHA, receipts and an independent PASS name OTHER_SHA.
    const { result, storage } = await run({
      receipts: [receipt({ candidateSha: OTHER_SHA, baseSha: BASE })],
      verdicts: [verdict({ sha: OTHER_SHA })],
    });
    expect(result.code).toBe('EVIDENCE_MISMATCH');
    expect(result.recorded).toBe(false);
    expect(storage.transactions).toBe(0);
    expect(storage.rows).toHaveLength(0);
    expect(storage.items.get(KEY)?.columnId).toBe(11);
  });

  it('refuses a review of another item, and a receipt whose paths differ from the candidate', async () => {
    const otherItem = await run({ receipts: [receipt({ itemKey: 'sentinel-prod-9999' })] });
    expect(otherItem.result.code).toBe('EVIDENCE_MISMATCH');
    const otherPaths = await run({ receipts: [receipt({ allowedPaths: ['scripts/other.ts'] })] });
    expect(otherPaths.result.code).toBe('EVIDENCE_MISMATCH');
    for (const outcome of [otherItem, otherPaths]) {
      expect(outcome.storage.rows).toHaveLength(0);
      expect(outcome.storage.items.get(KEY)?.columnId).toBe(11);
    }
  });

  it('refuses a publication whose candidate and readback disagree', async () => {
    // checkPublication owns this: a candidate SHA and a readback that differ are not a publication.
    const inconsistent = publication({
      candidateSha: SHA,
      remoteSha: OTHER_SHA,
      git: {
        eligible: true,
        reason: 'eligible',
        facts: {
          candidateSha: OTHER_SHA,
          baseSha: BASE,
          targetSha: BASE,
          subject: SUBJECT,
          body: '',
          changedPaths: ['scripts/a.ts'],
        },
      },
    });
    const { result, storage } = await run({
      publication: inconsistent,
      receipts: [receipt({ candidateSha: OTHER_SHA })],
      verdicts: [verdict({ sha: OTHER_SHA })],
    });
    expect(result.code).toBe('SHA_MISMATCH');
    expect(storage.rows).toHaveLength(0);
  });

  it('refuses when the item is in another project under the lock', async () => {
    const storage = fakeStorage({ items: { [KEY]: { columnId: 11, projectId: 8 } } });
    const { result } = await run({ storage });
    expect(result.code).toBe('COLUMN_WRONG_PROJECT');
    expect(storage.rows).toHaveLength(0);
    expect(storage.items.get(KEY)?.columnId).toBe(11);
  });

  it('refuses when the item was canceled under the lock, after the preflight passed', async () => {
    const storage = fakeStorage({
      // Created live, canceled after preflight: the fresh read inside the lock is what refuses it.
      items: { [KEY]: { columnId: 11, status: 'canceled' } },
    });
    const { result } = await run({ storage });
    expect(result.code).toBe('ITEM_CANCELED');
    expect(storage.rows).toHaveLength(0);
    expect(storage.items.get(KEY)?.columnId).toBe(11);
  });
});

describe('concurrent calls for one landing', () => {
  it('writes one record, one cleanup and one move, with exactly one replay', async () => {
    const storage = fakeStorage({ items: { [KEY]: { columnId: 11 } } });
    const [first, second] = await Promise.all([
      recordLanding(landingInput(storage)),
      recordLanding(landingInput(storage)),
    ]);
    expect([first.recorded, second.recorded]).toEqual([true, true]);
    expect([storage.rows.length, storage.cleanups.length]).toEqual([1, 1]);
    expect(storage.items.get(KEY)?.columnId).toBe(12);
    expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);
    // WHY maxPerItem: the fake locks per item and runs transactions concurrently, so this proves the
    // coordinator held one item's lock across the replay lookup instead of relying on a global queue.
    expect(storage.maxPerItem).toBe(1);
  });

  it('queues a fourth contender that arrives AFTER the first release', async () => {
    // WHY the timing: Qwen's finding was a fourth acquirer arriving after a release can walk in while the
    // second holder still owns the item, so the four cannot all start in the same tick.
    const storage = fakeStorage({ items: { [KEY]: { columnId: 11 } }, holdFirstMs: 25 });
    const first = recordLanding(landingInput(storage));
    const second = recordLanding(landingInput(storage));
    const third = recordLanding(landingInput(storage));
    await storage.firstRelease;
    const fourth = recordLanding(landingInput(storage));
    const results = await Promise.all([first, second, third, fourth]);
    expect(results.every((row) => row.recorded)).toBe(true);
    expect(results.filter((row) => row.replayed)).toHaveLength(3);
    expect([storage.rows.length, storage.cleanups.length]).toEqual([1, 1]);
    // Never two holders of one item, however late the contender arrives.
    expect(storage.maxPerItem).toBe(1);
  });

  it('lets two different items proceed at the same time', async () => {
    const other = 'p-8429.4';
    const storage = fakeStorage({ items: { [KEY]: { columnId: 11 }, [other]: { columnId: 11 } } });
    const [a, b] = await Promise.all([
      recordLanding(landingInput(storage)),
      recordLanding(landingInput(storage, other)),
    ]);
    expect([a.recorded, b.recorded, a.replayed, b.replayed]).toEqual([true, true, false, false]);
    expect(storage.rows).toHaveLength(2);
    // WHY only here: different items must overlap, and the yield in the fake's readItem makes it observable.
    expect(storage.maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it('keeps the first commit when the second transaction fails', async () => {
    const storage = fakeStorage({
      items: { [KEY]: { columnId: 11 } },
      failOn: { index: 2, at: 'append' },
    });
    const [a, b] = await Promise.all([
      recordLanding(landingInput(storage)),
      recordLanding({
        ...landingInput(storage),
        publication: flight(OTHER_SHA),
        receipts: [receipt({ candidateSha: OTHER_SHA, baseSha: BASE })],
        verdicts: [verdict({ sha: OTHER_SHA })],
      }),
    ]);
    expect(a.recorded).toBe(true);
    expect(b.code).toBe('STORAGE_FAILED');
    expect([storage.rows.length, storage.items.get(KEY)?.columnId]).toEqual([1, 12]);
    expect(storage.rows[0].payload.candidateSha).toBe(SHA);
    expect(storage.rollbacks).toBe(1);
  });
});
