// The page read of the ready pool judges every candidate with a bounded number of judgments in
// flight. No database: the judgment is a stand-in that mimics what one card costs the rule owner,
// two gates, the state op and then the claim op. sentinel-prod-8429.
import { describe, expect, test } from 'bun:test';
import { HttpError } from '#shared/lib';
import { JUDGE_CONCURRENCY, judgePage } from '../../ready';
import type { Candidate, ReadyItem } from '../../ready';

const rows = (n: number): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, priority: 'low' }));
const itemOf = (row: Candidate): ReadyItem => ({
  id: Number(row.id),
  beadId: `sentinel-prod-${row.id}`,
  title: `card ${row.id}`,
  priority: row.priority,
  epoch: 0,
});

// A judgment that counts the two gates one card really pays for, and how many judgments were
// running at the same moment.
const makeJudge = () => {
  const counters = {
    stateGates: 0,
    claimGates: 0,
    inFlight: 0,
    maxInFlight: 0,
    judged: [] as number[],
  };
  const judge = async (row: Candidate): Promise<ReadyItem> => {
    counters.inFlight += 1;
    counters.maxInFlight = Math.max(counters.maxInFlight, counters.inFlight);
    counters.stateGates += 1; // the routing op judgeGatedClaim gates first
    await Promise.resolve();
    counters.claimGates += 1; // then the claim op with the readiness and lease facts
    counters.judged.push(Number(row.id));
    counters.inFlight -= 1;
    return itemOf(row);
  };
  return { judge, counters };
};

describe('judgePage', () => {
  test('the bound is the measured one, not a rounder guess', () => {
    expect(JUDGE_CONCURRENCY).toBe(2);
  });

  test('every candidate on the page is judged, once, and both of its judgments are paid', async () => {
    const { judge, counters } = makeJudge();
    const excluded: Record<string, number> = {};
    const items = await judgePage(rows(25), judge, excluded);
    expect(items.length).toBe(25);
    expect(counters.judged.length).toBe(25);
    expect(new Set(counters.judged).size).toBe(25);
    // Two gates per card: the routing op judgeGatedClaim gates first, then the claim op with the
    // readiness and lease facts. No card is judged on the routing answer alone, and none is skipped.
    expect(counters.stateGates).toBe(25);
    expect(counters.claimGates).toBe(25);
    expect(counters.stateGates + counters.claimGates).toBe(50);
    expect(excluded).toEqual({});
  });

  test('at most the bound is in flight, and the page still overlaps judgments', async () => {
    const { judge, counters } = makeJudge();
    await judgePage(rows(25), judge, {});
    expect(counters.maxInFlight).toBeGreaterThan(1);
    expect(counters.maxInFlight).toBeLessThanOrEqual(JUDGE_CONCURRENCY);
  });

  test('a caller cannot raise the bound above the measured one', async () => {
    const { judge, counters } = makeJudge();
    await judgePage(rows(25), judge, {}, 25);
    expect(counters.maxInFlight).toBeLessThanOrEqual(JUDGE_CONCURRENCY);
  });

  test('the page answers in candidate order, not completion order', async () => {
    // The last card answers first on purpose: an unordered collection would put it at the front of
    // the pool, and the pool is ordered by priority and age.
    const judge = async (row: Candidate): Promise<ReadyItem> => {
      await new Promise((resolve) => setTimeout(resolve, (7 - Number(row.id)) * 2));
      return itemOf(row);
    };
    const items = await judgePage(rows(6), judge, {});
    expect(items.map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('a refused card is counted under its reason and its neighbours still answer', async () => {
    const excluded: Record<string, number> = {};
    const judge = async (row: Candidate): Promise<ReadyItem> => {
      if (Number(row.id) === 2) throw new HttpError(409, 'refused', 'tracker-rules-violation');
      if (Number(row.id) === 5) throw new HttpError(409, 'refused', 'claim-unproven-kind-unknown');
      if (Number(row.id) === 6) throw new HttpError(404, 'gone');
      return itemOf(row);
    };
    const items = await judgePage(rows(6), judge, excluded);
    expect(items.map((item) => item.id)).toEqual([1, 3, 4]);
    expect(excluded).toEqual({ 'owner-refused': 1, 'kind-unknown': 1, gone: 1 });
  });

  test('an error about the whole request fails the request', async () => {
    const judge = async (row: Candidate): Promise<ReadyItem> => {
      if (row.id === 3) throw new Error('the rule owner is not configured');
      return itemOf(row);
    };
    await expect(judgePage(rows(6), judge, {})).rejects.toThrow('not configured');
  });

  test('a page with no candidates judges nothing', async () => {
    const { judge, counters } = makeJudge();
    expect(await judgePage([], judge, {})).toEqual([]);
    expect(counters.stateGates).toBe(0);
    expect(counters.maxInFlight).toBe(0);
  });
});
